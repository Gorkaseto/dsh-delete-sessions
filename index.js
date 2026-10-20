/**
 * Host half of the dsh-delete-sessions bundle.
 *
 * DSH ships no way to delete a Session (archive only hides it), so this half
 * exposes one Remote method, `deleteSessions/remove(sessionId)`, through the
 * Gateway's SRC fallback: a plain service carrying a `typertRemote` binding
 * and the protocol's prototype marker, with no generated codecs.
 *
 * Deleting a Session:
 * 1. archives it with `stopActivity`, which hides the row and stops its turn,
 *    schedules, jobs and subagents;
 * 2. removes its whole folder `<DSH_HOME>/sessions/<project>/<sessionId>/`
 *    plus its projection-cache record;
 * 3. drops it from every Workspace account and the pin/archive sets, and
 *    emits `api-session/removed` so the sidebar row goes away.
 *
 * A Session that is live in this Host (opened since startup) keeps appending
 * to its log, so its folder cannot be removed under it: it stays archived and
 * is queued in `<DSH_HOME>/storages/dsh-delete-sessions.json`, and the queue is
 * flushed the next time the Host starts. `deleteSessions/pending()` lists the
 * queue and `deleteSessions/restore(sessionId)` undoes a queued deletion.
 */
import { readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, isAbsolute } from 'node:path'

export const name = 'dsh-delete-sessions'
export const inject = ['workspaceRegistry', 'sessions', 'agents']

const NAMESPACE = 'deleteSessions'
const REMOTE_MARK = '@deepseek-ai/dsh-typert-protocol/remote-methods'

function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

const home = dshHome()
const sessionsRoot = join(home, 'sessions')
const pendingFile = join(home, 'storages', 'dsh-delete-sessions.json')
const projectionFile = (sessionId) => join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)

function validId(sessionId) {
  return typeof sessionId === 'string' && /^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId !== '.' && sessionId !== '..'
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Every `<root>/<project>/<sessionId>` folder that holds a session log. */
async function findSessionDirs(sessionId) {
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(sessionsRoot, project.name, sessionId)
    let files
    try {
      files = await readdir(dir)
    } catch {
      continue
    }
    if (files.some((file) => /^session\.v\d+\.jsonl/.test(file)) && inside(sessionsRoot, dir)) found.push(dir)
  }
  return found
}

/**
 * The deletion queue: `sessionIds` to delete on the next start, and the subset
 * `archivedBefore` that was already archived when queued (an undo keeps those
 * archived and restores the rest).
 */
async function readPending() {
  try {
    const parsed = JSON.parse(await readFile(pendingFile, 'utf8'))
    const ids = (value) => Array.isArray(value) ? value.filter(validId) : []
    return { sessionIds: ids(parsed.sessionIds), archivedBefore: ids(parsed.archivedBefore) }
  } catch {
    return { sessionIds: [], archivedBefore: [] }
  }
}

async function writePending({ sessionIds, archivedBefore }) {
  const queued = [...new Set(sessionIds)]
  await mkdir(dirname(pendingFile), { recursive: true })
  await writeFile(pendingFile, JSON.stringify({
    sessionIds: queued,
    archivedBefore: [...new Set(archivedBefore)].filter((id) => queued.includes(id)),
  }, null, 2))
}

/** Serialize queue read-modify-write cycles. */
let queueChain = Promise.resolve()
function updatePending(change) {
  const next = queueChain.then(async () => {
    const queue = await readPending()
    const result = await change(queue)
    await writePending(queue)
    return result
  })
  queueChain = next.catch(() => {})
  return next
}

export function apply(ctx) {
  const registry = ctx.workspaceRegistry

  /** Forget a Session in the Workspace registry once its files are gone. */
  async function forget(sessionId) {
    for (const workspace of registry.list()) await workspace.detachSession(sessionId)
    await registry.unpinSession(sessionId)
    await registry.unarchiveSession(sessionId)
  }

  /** Remove a Session's folder(s) and cache record. */
  async function removeFiles(sessionId) {
    const dirs = await findSessionDirs(sessionId)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    await rm(projectionFile(sessionId), { force: true })
    return dirs.length
  }

  class DeleteSessions {
    /**
     * Permanently delete one Session.
     * @param sessionId - Session identity.
     * @returns `{ deleted: true }`, or `{ deleted: false, pending: true }` when
     * the Session is live and will be removed on the next Host start.
     */
    async remove(sessionId) {
      if (!validId(sessionId)) throw new Error(`dsh-delete-sessions: invalid session id ${JSON.stringify(sessionId)}`)
      if ((await findSessionDirs(sessionId)).length === 0) {
        throw new Error('dsh-delete-sessions: no stored log for this session')
      }
      const archivedBefore = registry.archivedSessionIds.includes(sessionId)
      // Hide the row and stop everything it runs before touching its files.
      try {
        await registry.archiveSession(sessionId, { stopActivity: true })
      } catch (error) {
        ctx.logger?.warn?.('archive before delete failed: %s', error?.message ?? error)
      }
      const live = ctx.sessions.get(sessionId) !== undefined || ctx.agents.get(sessionId) !== undefined
      if (live) {
        await updatePending((queue) => {
          if (queue.sessionIds.includes(sessionId)) return
          queue.sessionIds.push(sessionId)
          if (archivedBefore) queue.archivedBefore.push(sessionId)
        })
        return { deleted: false, pending: true }
      }
      await removeFiles(sessionId)
      await forget(sessionId)
      ctx.emit('api-session/removed', sessionId)
      return { deleted: true, pending: false }
    }

    /** @returns the Session ids queued for deletion on the next start. */
    async pending() {
      return (await readPending()).sessionIds
    }

    /**
     * Undo a queued deletion: drop it from the queue and unarchive it unless
     * it was already archived before the delete.
     * @param sessionId - Session identity.
     * @returns `{ restored }` — false when it was not queued.
     */
    async restore(sessionId) {
      if (!validId(sessionId)) throw new Error(`dsh-delete-sessions: invalid session id ${JSON.stringify(sessionId)}`)
      const entry = await updatePending((queue) => {
        if (!queue.sessionIds.includes(sessionId)) return null
        const archivedBefore = queue.archivedBefore.includes(sessionId)
        queue.sessionIds = queue.sessionIds.filter((id) => id !== sessionId)
        return { archivedBefore }
      })
      if (entry === null) return { restored: false }
      if (!entry.archivedBefore) await registry.unarchiveSession(sessionId)
      return { restored: true }
    }
  }
  const direct = (method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) })
  Object.defineProperty(DeleteSessions.prototype, REMOTE_MARK, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze([direct('remove'), direct('pending'), direct('restore')]),
    }),
  })

  const service = new DeleteSessions()
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })
  ctx.provide(NAMESPACE, service)

  // Flush deletions queued for Sessions that were live last run.
  ctx.effect(() => {
    let cancelled = false
    // Held on the queue chain so an undo cannot interleave with the flush.
    void updatePending(async (queue) => {
      const left = []
      for (const sessionId of queue.sessionIds) {
        if (cancelled) { left.push(sessionId); continue }
        if (ctx.sessions.get(sessionId) !== undefined || ctx.agents.get(sessionId) !== undefined) {
          left.push(sessionId)
          continue
        }
        try {
          await removeFiles(sessionId)
          await forget(sessionId)
          ctx.emit('api-session/removed', sessionId)
        } catch (error) {
          ctx.logger?.warn?.('queued delete of %s failed: %s', sessionId, error?.message ?? error)
          left.push(sessionId)
        }
      }
      queue.sessionIds = left
    }).catch((error) => {
      ctx.logger?.warn?.('flushing queued deletions failed: %s', error?.message ?? error)
    })
    return () => { cancelled = true }
  }, 'dsh-delete-sessions: flush queued deletions')
}

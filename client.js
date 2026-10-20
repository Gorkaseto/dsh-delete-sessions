/**
 * Delete sessions — Client half of the dsh-delete-sessions bundle.
 *
 * Adds a "Delete session" row to the sidebar Session "..." menu (slot
 * `sidebar.workspaces.session.menu.item`, after the shipped Archive row) and
 * a confirmation dialog in `shell.overlay`. The row closes the menu (which
 * unmounts it), so the pending request lives in a tiny module store the
 * overlay reads.
 *
 * A Session queued for deletion on the next start shows "Undo scheduled
 * deletion" as its menu's only row (the other rows are hidden while the menu
 * is open), and its row's hover buttons (unarchive, pin) are replaced by one
 * "Undo scheduled deletion" button (`sidebar.workspaces.session.row.action`);
 * the queue is read from the Host on load and on reconnect.
 *
 * Confirming calls the Host half's `deleteSessions/remove` straight over the
 * Connection carrier (`connection.rpc.call('/api', …)`): the endpoint is
 * served by the Gateway's SRC fallback, which has no generated Client codecs
 * for `ctx.remote` to mount.
 *
 * Styles use only theme tokens under this plugin's `ds-` prefix; the menu row
 * copies the class of a sibling shipped row so it looks native.
 */
window.__ModuleLoader__.load({
  id: 'dsh-delete-sessions',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useLayoutEffect, useRef, useState, useSyncExternalStore } = React
    const { createPortal } = require('react-dom')

    const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
    const OVERLAY_SLOT = 'shell.overlay'
    const NS = 'dsh-delete-sessions'
    const ENDPOINT = 'deleteSessions/remove'
    const PENDING_ENDPOINT = 'deleteSessions/pending'
    const RESTORE_ENDPOINT = 'deleteSessions/restore'

    const en = {
      'menu.delete': 'Delete session',
      'menu.undo': 'Undo scheduled deletion',
      'hover.queued': 'Deleting on next restart',
      'confirm.title': 'Delete session?',
      'confirm.desc': '“{title}” will be permanently deleted from disk. This cannot be undone.',
      'confirm.untitled': 'Untitled session',
      'confirm.action': 'Delete',
      'confirm.pending': 'Deleting…',
      'cancel': 'Cancel',
      'close': 'Close',
      'result.pending': 'This session is open in the running app. It has been archived and will be deleted the next time DSH starts.',
      'error.action': 'Couldn’t delete the session: {message}',
      'error.undo': 'Couldn’t undo the scheduled deletion: {message}',
    }

    const zh = {
      'menu.delete': '删除会话',
      'menu.undo': '撤销计划删除',
      'hover.queued': '将在下次重启时删除',
      'confirm.title': '删除会话？',
      'confirm.desc': '“{title}”将从磁盘上永久删除，且无法恢复。',
      'confirm.untitled': '未命名会话',
      'confirm.action': '删除',
      'confirm.pending': '正在删除…',
      'cancel': '取消',
      'close': '关闭',
      'result.pending': '该会话已在当前运行的应用中打开。它已被归档，并将在下次启动 DSH 时删除。',
      'error.action': '删除会话失败：{message}',
      'error.undo': '撤销计划删除失败：{message}',
    }

    const CSS = `
.ds-item { color: var(--dsw-alias-state-error-primary) !important; }
.ds-item svg { flex: none; }
.ds-backdrop {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 16px; background: rgba(0, 0, 0, 0.5);
}
.ds-dialog {
  width: 100%; max-width: 420px; padding: 20px; border-radius: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.ds-title { margin: 0 0 8px; font-size: 16px; font-weight: 600; line-height: 24px; }
.ds-desc { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; word-break: break-word; }
.ds-note, .ds-error { margin-top: 12px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 18px; }
.ds-note { background: var(--dsw-alias-interactive-bg-hover, transparent); color: var(--dsw-alias-label-secondary, var(--dsw-alias-label-primary)); }
.ds-error { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
.ds-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
.ds-button {
  height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, var(--dsw-alias-border-l1));
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.ds-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
.ds-button:disabled { cursor: default; opacity: 0.55; }
.ds-danger { color: var(--dsw-alias-state-error-primary); }
.ds-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
`

    /** Parse a computed `rgb()`/`rgba()` colour; null when unparseable. */
    function parseColor(value) {
      const match = /^rgba?\(([^)]+)\)$/.exec(value.trim())
      if (match === null) return null
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number)
      return { alpha: parts.length > 3 ? parts[3] : 1 }
    }

    /**
     * A fully opaque surface colour for the dialogs. Theme tokens differ
     * between DSH versions (and some are translucent), so each candidate is
     * resolved through a probe element and the first opaque one wins.
     */
    function solidSurface() {
      const probe = document.createElement('div')
      probe.style.display = 'none'
      document.body.appendChild(probe)
      try {
        const tokens = ['--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-base']
        for (const token of tokens) {
          probe.style.backgroundColor = ''
          probe.style.backgroundColor = `var(${token})`
          const color = getComputedStyle(probe).backgroundColor
          if (parseColor(color)?.alpha === 1) return color
        }
      } finally {
        probe.remove()
      }
      for (const element of [document.getElementById('root'), document.body, document.documentElement]) {
        if (element === null) continue
        const color = getComputedStyle(element).backgroundColor
        if (parseColor(color)?.alpha === 1) return color
      }
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? '#1f2024' : '#ffffff'
    }

    /** The dialog card, painted with an opaque surface. */
    function DialogCard(props) {
      const [background] = useState(solidSurface)
      return h('div', { ...props, className: 'ds-dialog', style: { backgroundColor: background } })
    }

    function errorText(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** A tiny external store; `requests` holds `{ sessionId, title }` or null, `queued` a Set of ids. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) { value = next; for (const fn of listeners) fn() },
        subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn) } },
      }
    }

    function TrashIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 4h11M6.5 4V2.75c0-.41.34-.75.75-.75h1.5c.41 0 .75.34.75.75V4M4 4l.6 9.1c.04.5.46.9.97.9h4.86c.51 0 .93-.4.97-.9L12 4M6.75 6.75v4.5M9.25 6.75v4.5',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /** "Restore from trash": the trash can with an up arrow inside. */
    function UndoDeleteIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.5 4h11M6.5 4V2.75c0-.41.34-.75.75-.75h1.5c.41 0 .75.34.75.75V4M4 4l.6 9.1c.04.5.46.9.97.9h4.86c.51 0 .93-.4.97-.9L12 4M8 11.75V7.25M6.25 9 8 7.25 9.75 9',
          stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    const ROW_ACTION_SLOT = 'sidebar.workspaces.session.row.action'
    const ROW_HOVER_SLOT = 'sidebar.session.row.hover'

    /**
     * Hover-card line for a Session queued for deletion: "Deleting on next
     * restart" in place of the shipped "Archived" line (the card's last line,
     * which it hides and whose class it borrows). Renders nothing for other rows.
     */
    function QueuedHoverLine({ sessionId, queued, t }) {
      const ref = useRef(null)
      const [shipped, setShipped] = useState('')
      const isQueued = useSyncExternalStore(queued.subscribe, () => queued.get().has(sessionId))
      useLayoutEffect(() => {
        const anchor = ref.current?.closest(`[data-slot="${ROW_HOVER_SLOT}"]`)
        const archivedLine = anchor?.parentElement?.lastElementChild
        if (archivedLine === null || archivedLine === undefined || archivedLine === anchor) return
        if (archivedLine.querySelector('svg') === null) return
        setShipped(archivedLine.className)
        const previous = archivedLine.style.display
        archivedLine.style.display = 'none'
        return () => { archivedLine.style.display = previous }
      }, [isQueued])
      if (!isQueued) return null
      return h('div', { ref, className: shipped }, h(TrashIcon), h('span', null, t('hover.queued')))
    }

    /**
     * Hover button for a Session queued for deletion: replaces the shipped
     * row buttons (unarchive, pin) with one "Undo scheduled deletion" button.
     * Renders nothing for other rows.
     */
    function UndoRowAction({ sessionId, queued, restore, requests, t }) {
      const ref = useRef(null)
      const [shipped, setShipped] = useState('')
      const isQueued = useSyncExternalStore(queued.subscribe, () => queued.get().has(sessionId))
      useLayoutEffect(() => {
        const strip = ref.current?.closest(`[data-slot="${ROW_ACTION_SLOT}"]`)
        if (strip === null || strip === undefined) return
        const sibling = [...strip.querySelectorAll('button')].find((node) => node !== ref.current)
        if (sibling) setShipped(sibling.className)
        const hidden = []
        for (const child of strip.children) {
          if (child === ref.current || child.contains(ref.current) || child.style.display === 'none') continue
          hidden.push(child)
          child.style.display = 'none'
        }
        return () => { for (const element of hidden) element.style.display = '' }
      }, [isQueued])
      if (!isQueued) return null
      return h('button', {
        ref,
        type: 'button',
        className: shipped,
        title: t('menu.undo'),
        'aria-label': t('menu.undo'),
        onClick: () => {
          restore(sessionId).catch((reason) => {
            requests.set({ kind: 'error', sessionId, message: t('error.undo', { message: errorText(reason) }) })
          })
        },
      }, h(UndoDeleteIcon))
    }

    /**
     * Hide every other row of the menu `node` sits in (walking up to the menu,
     * hiding each ancestor's siblings), so the queued Session's menu offers
     * only the undo row.
     * @returns a function that shows them again.
     */
    function hideOtherRows(node) {
      const menu = node.closest('[role="menu"]')
      if (menu === null) return () => {}
      const hidden = []
      for (let keep = node; keep !== menu && keep.parentElement !== null; keep = keep.parentElement) {
        for (const sibling of keep.parentElement.children) {
          if (sibling === keep || sibling.tagName === 'STYLE' || sibling.style.display === 'none') continue
          hidden.push(sibling)
          sibling.style.display = 'none'
        }
      }
      return () => { for (const element of hidden) element.style.display = '' }
    }

    /**
     * Menu row: "Delete session", or — for a Session queued for deletion on
     * the next start — "Undo scheduled deletion" as the menu's only row.
     * Borrows a shipped sibling row's class so it matches the menu.
     */
    function DeleteMenuItem({ sessionId, displayTitle, useMenuOpenState, requests, queued, restore, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      const ref = useRef(null)
      const [shipped, setShipped] = useState('')
      const isQueued = useSyncExternalStore(queued.subscribe, () => queued.get().has(sessionId))
      useLayoutEffect(() => {
        const menu = ref.current?.closest('[role="menu"]')
        const sibling = menu === null || menu === undefined
          ? null
          : [...menu.querySelectorAll('button[role="menuitem"]')].find((node) => node !== ref.current)
        if (sibling) setShipped(sibling.className)
      }, [])
      useLayoutEffect(() => {
        if (!isQueued || ref.current === null) return
        const showRows = hideOtherRows(ref.current)
        // The shipped menu surface is translucent; with a single row it reads
        // as see-through, so paint this card with an opaque surface.
        const menu = ref.current.closest('[role="menu"]')
        const previous = menu?.style.backgroundColor ?? ''
        if (menu !== null) menu.style.backgroundColor = solidSurface()
        return () => {
          showRows()
          if (menu !== null) menu.style.backgroundColor = previous
        }
      }, [isQueued])
      const onClick = () => {
        setMenuOpen(false)
        if (!isQueued) {
          requests.set({ kind: 'confirm', sessionId, title: displayTitle })
          return
        }
        restore(sessionId).catch((reason) => {
          requests.set({ kind: 'error', sessionId, message: t('error.undo', { message: errorText(reason) }) })
        })
      }
      return h('button', {
        ref,
        type: 'button',
        role: 'menuitem',
        className: isQueued ? shipped : `${shipped} ds-item`,
        onClick,
      },
        h('style', null, CSS),
        isQueued ? h(UndoDeleteIcon) : h(TrashIcon),
        h('span', null, t(isQueued ? 'menu.undo' : 'menu.delete')))
    }

    /** One request's dialog; in-flight and error state die with it. */
    function ConfirmDialog({ request, onClose, remove, t }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [queued, setQueued] = useState(false)
      const close = () => { if (!busy) onClose() }
      const confirm = () => {
        setBusy(true)
        setError(null)
        remove(request.sessionId).then((value) => {
          setBusy(false)
          if (value?.pending === true) setQueued(true)
          else onClose()
        }, (reason) => {
          setBusy(false)
          setError(t('error.action', { message: errorText(reason) }))
        })
      }
      const title = request.title.length > 0 ? request.title : t('confirm.untitled')
      return createPortal(h('div', {
        className: 'ds-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) close() },
        onKeyDown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } },
      },
        h('style', null, CSS),
        h(DialogCard, { role: 'alertdialog', 'aria-modal': true, 'aria-labelledby': 'ds-title' },
          h('h2', { id: 'ds-title', className: 'ds-title' }, t('confirm.title')),
          h('p', { className: 'ds-desc' }, t('confirm.desc', { title })),
          queued ? h('div', { className: 'ds-note', role: 'status' }, t('result.pending')) : null,
          error !== null ? h('div', { className: 'ds-error', role: 'alert' }, error) : null,
          h('div', { className: 'ds-footer' },
            queued
              ? h('button', { type: 'button', className: 'ds-button', autoFocus: true, onClick: onClose }, t('close'))
              : [
                  h('button', { key: 'cancel', type: 'button', className: 'ds-button', disabled: busy, onClick: close }, t('cancel')),
                  h('button', {
                    key: 'ok', type: 'button', className: 'ds-button ds-danger', disabled: busy, autoFocus: true, onClick: confirm,
                  }, busy ? t('confirm.pending') : t('confirm.action')),
                ]))), document.body)
    }

    /** A failed undo: the Host's message and a Close button. */
    function ErrorDialog({ message, onClose, t }) {
      return createPortal(h('div', {
        className: 'ds-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
        onKeyDown: (event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } },
      },
        h('style', null, CSS),
        h(DialogCard, { role: 'alertdialog', 'aria-modal': true },
          h('div', { className: 'ds-error', role: 'alert' }, message),
          h('div', { className: 'ds-footer' },
            h('button', { type: 'button', className: 'ds-button', autoFocus: true, onClick: onClose }, t('close'))))),
      document.body)
    }

    function DeleteOverlay({ requests, remove, t }) {
      const request = useSyncExternalStore(requests.subscribe, requests.get)
      if (request === null) return null
      const onClose = () => { requests.set(null) }
      if (request.kind === 'error') return h(ErrorDialog, { key: request.sessionId, message: request.message, onClose, t })
      return h(ConfirmDialog, { key: request.sessionId, request, remove, t, onClose })
    }

    return {
      inject: ['connection', 'locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-delete-sessions: locale dictionaries')
        const t = ctx.locale.bind(NS)
        const requests = createStore(null)
        const queued = createStore(new Set())

        /** Call one Host method; rejects with the Host's message. */
        const call = async (endpoint, args) => {
          const result = await ctx.connection.rpc.call('/api', endpoint, { args })
          if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? 'unknown failure')
          return result.value
        }

        /** Reload the ids queued for deletion on the next start. */
        const refreshQueued = () => {
          call(PENDING_ENDPOINT, {}).then(
            (ids) => { queued.set(new Set(Array.isArray(ids) ? ids : [])) },
            () => {},
          )
        }

        /** Delete one Session; a live one joins the queue. */
        const remove = async (sessionId) => {
          const value = await call(ENDPOINT, { sessionId })
          if (value?.pending === true) queued.set(new Set([...queued.get(), sessionId]))
          return value
        }

        /** Undo a queued deletion. */
        const restore = async (sessionId) => {
          await call(RESTORE_ENDPOINT, { sessionId })
          const next = new Set(queued.get())
          next.delete(sessionId)
          queued.set(next)
        }

        refreshQueued()
        ctx.on('connection/reset', refreshQueued)

        ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
          name: MENU_SLOT,
          id: 'dsh-delete-sessions.delete',
          // After the shipped archive (400) and session-id (450) rows.
          order: 900,
          inject: () => ({ requests, queued, restore, t }),
        }, DeleteMenuItem))

        ctx.slots.inject(ROW_ACTION_SLOT, () => ctx.slots.register({
          name: ROW_ACTION_SLOT,
          id: 'dsh-delete-sessions.undo',
          // Before the shipped archive (100) and pin (200) buttons.
          order: 50,
          inject: () => ({ requests, queued, restore, t }),
        }, UndoRowAction))

        ctx.slots.inject(ROW_HOVER_SLOT, () => ctx.slots.register({
          name: ROW_HOVER_SLOT,
          id: 'dsh-delete-sessions.queued',
          inject: () => ({ queued, t }),
        }, QueuedHoverLine))

        ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
          name: OVERLAY_SLOT,
          id: 'dsh-delete-sessions.confirm',
          inject: () => ({ requests, remove, t }),
        }, DeleteOverlay))

        ctx.effect(() => () => { requests.set(null) }, 'dsh-delete-sessions: drop pending request')
      },
    }
  },
})

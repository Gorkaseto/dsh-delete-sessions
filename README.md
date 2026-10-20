# DSH Delete Sessions

A plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) (`dsh-delete-sessions`) that adds a permanent **"Delete session"** action to the sidebar session menu (`...`).

By default, DeepSeek Harness only supports archiving sessions, which hides them from the sidebar while leaving all session data on disk. This plugin permanently removes sessions and their files, complete with a confirmation dialog and safe deferred deletion for active sessions.

## Features

- **Permanent Deletion**: Removes the session folder (`<DSH_HOME>/sessions/<project>/<sessionId>/`), cache projection records, and workspace associations from disk.
- **Safe Handling for Active Sessions**: If a session is currently running or open in the host, it is queued for deletion and safely removed on the next DSH restart to prevent log corruption.
- **Undo Scheduled Deletion**: Any session queued for deferred deletion can be restored directly from the sidebar prior to restarting.
- **Native UI Integration**: Adds a styled "Delete session" option to the session context menu and renders an accessible confirmation modal.
- **Localization**: Built-in support for English (`en`) and Chinese (`zh`).

## How It Works

1. **Client (`client.js`)**:
   - Injects the "Delete session" row into the sidebar session menu (`sidebar.workspaces.session.menu.item`).
   - Renders a confirmation dialog in `shell.overlay` to prevent accidental deletion.
   - For sessions queued for deferred deletion, displays an "Undo scheduled deletion" action and status indicator.

2. **Host (`index.js`)**:
   - Exposes the remote method `deleteSessions/remove(sessionId)` via the gateway protocol.
   - Stops active turns, schedules, jobs, and subagents using `stopActivity`.
   - Removes session directories immediately or queues them in `<DSH_HOME>/storages/dsh-delete-sessions.json` if currently held open by the host.
   - Automatically flushes and deletes queued sessions upon host startup.

> [!NOTE]
> Deletion is permanent once executed. Subagent child sessions reside in independent directories and are not removed when deleting the parent session.

## Installation

Install the plugin into your DSH web profile:

```sh
# From a local folder
dsh plugin --profile web add file:path/to/dsh-delete-sessions

# Or directly from a Git repository
dsh plugin --profile web add https://github.com/Gorkaseto/dsh-delete-sessions.git
```

## Project Structure

```text
├── client.js          # Client module: UI menu items, confirmation dialog, and locale strings
├── index.js           # Host service: session cleanup, queue management, and RPC handlers
├── cordis.patch.yml   # Cordis plugin manifest definition
├── icon.svg           # Plugin icon
├── locale/            # Internationalization metadata files (en.json, zh.json)
├── package.json       # Plugin manifest and dependencies
├── LICENSE            # Apache-2.0 License
└── NOTICE             # Copyright and attribution notices
```

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for details.

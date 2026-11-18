# dsh-sidebar-session-delete

A DeepSeek Harness plugin that adds a **删除会话 / Delete session** entry to
the sidebar Session row "…" menu, next to the built-in archive action.

## Install

In DeepSeek Harness on the target computer, open **Plugins → Add plugin** and
enter the install source (the computer needs access to GitHub):

```
github:Ethan-Guan/dsh-sidebar-session-delete
```

Alternatively `git clone` the repository and pick the local directory in
**Add plugin**. Confirm the **Delete session** row is enabled in the plugin
list; a newly added plugin usually needs one DSH restart to load its module.

## Multi-select delete

The toolbar at the right of the Workspaces section gains a **multi-select**
button:

- Click it to enter selection mode; clicking any Session row toggles that row
  instead of opening it. Selected rows are outlined and the trailing seat shows
  a check mark.
- A floating bar shows how many rows are selected and offers **全选**
  (select every rendered Session row), **删除** (confirm and delete the
  selection) and **取消**. `Esc` also leaves selection mode.
- The Client posts the whole selection to `POST /api/session-delete/batch`.
  The Host deletes one Session at a time and reports each outcome, so a running
  Session is refused while the rest still go; failed rows stay selected and the
  dialog names the failure.
- The workspace toolbar exposes no client slot, so the button is mounted into
  the toolbar's stable `data-sidebar-workspace-header` marker (and the bar into
  the same section root). A DSH release that renames that marker needs a small
  adaptation in `lib/client.js`.

## What it does

- **Client half** (`lib/client.js`): registers one entry into the
  `sidebar.workspaces.session.menu.item` slot (order 440, between *archive* and
  *copy session id*), a selection mark into `sidebar.session.row.trailing`, and
  one confirmation dialog into `shell.overlay`. The menu entry opens the dialog;
  the dialog posts one or several Session ids to the Host and closes. The
  sidebar updates itself from the Host's live removal events, so a successful
  delete never reloads the page.
- **Host half** (`lib/index.js`): registers the exact `POST /api/session-delete`
  and `POST /api/session-delete/batch` Fetch routes through
  `connection.fetch.register`. Deleting a Session:
  1. refuses a Session with a running turn (stop the work first);
  2. stops the Session's remaining providers (reminders, jobs, idle descendants);
  3. clears the registry-global archive and pin sets;
  4. detaches the Session from every Workspace accounting slot;
  5. deletes the `session_projcache` projection row;
  6. flushes an idle resident Session and detaches it from the Session store, so
     its persistence writer closes and Clients receive `session/disposed`
     (the row disappears without waiting for a restart);
  7. removes `$DSH_HOME/sessions/<project>/<session-id>` from disk;
  8. announces `api-session/removed` for a cold Session, so the Client drops the
     row immediately without a reload (a resident Session already announced
     itself through `session/disposed`).

Deletion is permanent: the Session log is removed and cannot be restored. The
confirmation dialog says so explicitly.

## Resident (live) Sessions

A Session stays resident in the Host process after it has been opened once: the
Session Controller resumes an Agent whose lifecycle belongs to the controller
fiber, so it lives until the process exits. That is why an untouched-looking
Session can still be "live". This plugin deletes an **idle** resident Session
safely — flush, detach from the Session store (which closes the persistence
writer and announces the removal), then delete the artifacts. Only a Session
with an **open turn** is refused; stop it first, exactly like stop-and-archive.
Subagent children (`status: running` under their own UUIDs) are never listed in
the sidebar and are stopped by the Session's provider stop set.

## Install into a profile

The plugin is a plain dual-half package: the Host half is `lib/index.js`, and
the `dsh.client` declaration makes the Web app serve `lib/client.js` as the
browser half. Install it as a local package in a profile:

```sh
PROFILE="$HOME/.dsh/profiles/desktop"
cp -R session-delete "$PROFILE/node_modules/session-delete"
```

Then add one loader entry to the profile patch (`cordis.patch.yml`):

```yaml
- insert:
    - id: session-delete
      name: session-delete
```

With HMR enabled (the desktop profile default), the running Host recomposes the
profile and the open page loads the new plugin without a restart. Without HMR,
restart DSH.

## Verify

1. Reload the Web page once so the page boot reads the current plugin graph.
2. Open a Session row's "…" menu: **删除会话** appears above *Copy Session ID*.
3. Confirm any Session that is not mid-turn: the dialog asks for confirmation,
   the row disappears in place (no page reload, no flash), and
   `$DSH_HOME/sessions/<project>/<session-id>` is gone.
4. A Session with an open turn reports `session-active` instead of being torn
   down mid-turn.

Diagnostics endpoints (owner-authenticated, same origin):

| Route | Purpose |
| --- | --- |
| `POST /api/session-delete` | the delete call (`{ "sessionId": "..." }`) |
| `POST /api/session-delete/ping` | browser-half heartbeat, sent by `apply()` |
| `GET /api/session-delete/status` | `{ ok, loads, lastLoadAt, liveSessions }` diagnostics |

## Tests

```sh
node --test test/host.test.mjs test/client.test.mjs
```

`node` here means Node 24 or newer; with no system Node installed, use the
runtime bundled with DSH:
`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`.

- `host.test.mjs` drives `apply()` with a stub Cordis scope: cold delete across
  archive/pin/accounting/projection/log, idle-resident delete (flush + store
  detach), running-turn refusal, unknown Session, malformed input, heartbeat
  and live-session reporting.
- `client.test.mjs` executes the browser bundle in a VM with a stub module
  loader and asserts the slot registrations and the heartbeat POST.

## Files

| Path | Role |
| --- | --- |
| `package.json` | package identity + `dsh.client` declaration |
| `lib/index.js` | Host half: delete route + durable removal |
| `lib/client.js` | browser half: menu entry + confirmation dialog |
| `test/host.test.mjs` | Host-half unit tests |
| `test/client.test.mjs` | browser-half smoke test |

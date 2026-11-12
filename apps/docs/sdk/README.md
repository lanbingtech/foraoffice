# ForaOffice Docs SDK

This package embeds the Word editor and exposes its live editing runtime. It does
not configure a model or run an Agent. An external caller supplies instructions
and content, invokes tools, and consumes their results.

Source baseline: GenOffice `v0.12.852`, commit
`4b55db9ed1994575a695160ffc6cfd0bfc866211`. `build-info.json` records the source
checkout and whether it contained uncommitted changes. This is a development SDK;
the existence of a package does not declare the complete Docs milestone accepted.

## Build and install

From the repository root:

```sh
npm run build:sdk --workspace @genoffice/docs
```

The generated directory is `apps/docs/out/sdk`. It contains the complete renderer
assets, bundled Node services, TypeScript declarations, examples and Qt widget
sources. Copy that directory to another project, then install it locally:

```sh
npm install ./vendor/docs-sdk
```

The Node services require Node 24 or later. The package includes the Office CLI,
its external dependency closure and PDFium WASM; `npm pack` retains the bundled
dependencies. The standard MCP SDK is a peer dependency for
typed transport integration. A TypeScript Node consumer also needs `@types/node`.
The renderer includes React and its editor dependencies and has no dependency on
the original workspace packages.

## Embed the editor

Import `@foraoffice/docs-sdk/editor.css` and use the exported
`mountDocsEditor(container, { host, language?, signal? })`. Construct the host with
`createExternalDocsHost(kind, services, harness?, resources?)`; `kind` is
`electron`, `qt` or `browser`. `DocsEditorServices` is the typed native/file
service contract. It has no model transport or Agent configuration.

`examples/browser.ts` shows mounting and a direct tool call. Supply the actual
host implementations for file access, dialogs, assets, fonts, clipboard,
printing/export and application settings used by your integration. The service
contract does not grant permission to files by itself. The Node file service
enforces canonical read/write roots, exact dialog-approved files and private
state exclusion.

Await both the mount promise and `editor.ready` before using `editor.runtime` or
`editor.commands`. Call `editor.dispose()` when removing the view. One mounted
host/editor is supported per renderer window.

Mounted editors use the native ribbon's normal 10px side insets on macOS,
Windows and Linux, with File immediately before Save. They do not reserve space
for window buttons or turn the ribbon into a window drag region; the embedding
host owns those decorations. This is automatic for every `mountDocsEditor`
host kind and does not require URL parameters or CSS overrides. Standalone
Electron windows retain their platform-specific window-button spacing.

The optional `harness.submit(action)` callback forwards a user action to the
embedding application's external conversation. It is not needed for ordinary
tool execution. The application owns any conversation, model request or task
orchestration.

### Built-in AI operations and instructions

Built-in AI actions include a stable, UI-language-independent `operationId` and
structured `parameters`. The action's `id` remains a unique invocation ID, and
`bindingId` remains the existing document/selection authority. Neither identifier
should be used to infer which built-in operation was clicked.

| `operationId`                               | Parameters                   |
| ------------------------------------------- | ---------------------------- |
| `proofread_document`, `proofread_selection` | `{}`                         |
| `translate_document`, `translate_selection` | `{ targetLanguage: string }` |
| `suggest_synonyms`                          | `{}`                         |
| `resolve_comments`, `summarize_revisions`   | `{}`                         |
| `name_document`                             | `{}`                         |
| `summarize_document`                        | `{}`                         |
| `polish_document`, `polish_selection`       | `{}`                         |
| `format_document`, `create_mind_map`        | `{}`                         |

Translation uses the original language code, for example `fr`, `zh` or `zh-TW`,
not the translated language label. Equivalent Review/context-menu operations use
the same identifier. The Home shortcuts are identified too. Tools/F7 proofreading
retains its whole-document operation. These fields describe existing editor
actions; they do not select a model, provider, settings format or conversation API.

Hosts can optionally implement `harness.resolveInstruction(request, signal)`.
`DocsAiInstructionRequest` supplies the operation descriptor, `defaultInstruction`,
the invocation `id`, `documentId`, `bindingId` and projected `context`. The editor
captures and binds this context before calling the resolver. Public SDK exports
also include `DocsAiOperationId` and the discriminated `DocsAiOperation` type.

```ts
const harness: DocsHarnessAdapter = {
  resolveInstruction(request, signal) {
    signal.throwIfAborted()
    if (request.operationId === 'translate_selection') {
      return `Translate only the selected text into ${request.parameters.targetLanguage}. Preserve its meaning.`
    }
    return null
  },
  async submit(action) {
    // Forward this resolved instruction and its existing binding to the
    // application's conversation or task runner.
    await submitToConversation(action)
  },
}
```

The callback may be synchronous or asynchronous. Missing callbacks and
`null`/`undefined`/blank results preserve the editor default. A nonblank custom
string is preserved verbatim. Errors, including cancellation, refuse submission;
they do not silently fall back. External AI naming retains its previous empty
default instruction and `kind: 'name_document'`; the resolver can supply its task
text. Other existing kinds retain their meanings.

User-entered instructions and generic conversation focus do not carry an
`operationId` or `parameters` and never enter this resolver. Do not infer operations
by matching localized instruction text, even when a user types a default prompt.
Editable suggestion text in the selection popover is also a free instruction.

The request and its parameters are snapshots. A successful submission contains
the resolved instruction snapshot; later configuration changes do not rewrite it.
Cursor movement during resolution preserves the original selection. Document
content edits while resolving cancel the stale action. Document replacement,
closure, scope revocation and disposal cancel pending resolution; authored-state
and Harness identity are rechecked before submission. Hosts can cancel a pending
request with `editor.commands.releaseScope(request.bindingId)` and should observe
the standard `AbortSignal` when awaiting their own configuration or UI work. Even
an uncooperative resolver's late result cannot cause submission after cancellation.
`DocsRuntimeScope.signal` exposes the lifetime of captured document authority.

Template storage and settings UI belong to the embedding application. There is no
editor settings service or host-specific template schema associated with this hook.

The selection's Ask AI entry always opens the editor's instruction popover,
including when an external Harness is installed. Confirming with Send now or
Enter calls the existing `harness.submit(action)` with `kind: 'edit'`, the user's
`instruction`, `documentId`, `bindingId` and projected `context`. The binding
captures the document generation and selection at submission; later cursor
movement does not retarget it. The editor owns the input, selection highlight
and cancel/focus behavior; the host owns execution. Closing, Escape and outside
clicks cancel without submitting or queuing an external task. Replacing the
document closes an unfinished instruction. Native Agent mode retains its local
edit queue. No host-specific callback or configuration is required.

## Invoke the live document

Direct consumers use `editor.runtime.connect({ id })`, call `context()`, then
`execute({ id, name, input })` or `save({ path, overwrite })`. Close the caller
when its operation/session ends. Use a separate caller identity per independent
conversation. For a captured selection, use `runtime.capture()` and connect
through that scope. A scope stays bound to the captured document generation and
maps its selection across edits; it does not follow whichever document is later
opened in the same window.

`get_editor_capabilities` reports tool availability, restricted HTML rules and
the `apply_ops` signatures. The MCP surface contains 46 tool contracts, including
draft/review/history/media controls and optional resource helpers. Editing uses
the same document implementation as the native consumer. No inference is needed
to execute these primitives.

Operation results contain `documentId`, `revision`, `output`, `committed` and
optional `errorCode`/`pending`. `committed: null` means the host could not establish
an independent file operation's outcome. Cancellation does not imply that a file
write was rolled back. An outstanding draft must be finalized, retained or
discarded before saving. A stale target is refused; obtain fresh context and
reassess the intended operation before submitting a new call.

## Hosted documents, inspection and view annotations

The optional `host.documents: DocsDocumentHost` owns managed document identity
and storage. An identity is an opaque `id` and display `name`; `data` contains
complete DOCX bytes and can be omitted for a new blank document. A local path
is not required. Configure `initialDocument`, `newDocument`, `openDocument`,
`recentDocuments`, `saveDocument` and, when supported, `createDocument`.
Unsupported or disabled operations never fall back to local storage.

`saveDocument` receives the current identity, serialized bytes, `kind`
(`save`/`saveAs`) and `auto`. Return the normal `ok`, `committed`, `pending`
outcome. A successful save requires `committed: true` and `pending: false`.
Return a replacement `document` identity when adopting a new object. For Save As,
Save As requires an explicit boolean `adopt`; `true` also requires the adopted
`document` identity. `adopt: false` exports a copy while preserving the active object and dirty state.
The editor retains its existing save queue and handling of edits during saves.
`capabilities` can disable new/open/save/saveAs/export/create at their execution
boundary. Managed automatic saving initially defaults to off. `autoSave.enabled`
sets the initial editor-session switch; users can turn it on or off in the native
toolbar. Set `autoSave.allowToggle: false` to explicitly lock the switch to the
host's `enabled` value. Existing hosts that used `enabled: false` as an enforced
ban should also set `allowToggle: false`. `intervalMs` and `onBlur` retain their
existing timing behavior (30 seconds and on blur by default).

The displayed switch, timer/blur saves and close checks use the same effective
state. Automatic saving is off and the switch is disabled if the hosted document
is read-only, saving is forbidden by `capabilities.save`, or no `saveDocument`
handler exists. Turning the switch off stops future automatic saves; it does not
cancel a save already sent to the host. Manual saves retain their own policy.
Managed user choices last for the mounted editor, survive document changes, and
reset to the host's initial configuration on remount. They neither mutate host
configuration nor overwrite standalone/browser-local AutoSave preferences.

Hosted `readOnly`
restricts editing and saving while permitting inspection and view annotations.
The host owns managed recovery; the local recovery timer does not persist a
managed object behind its back. Independent file CLI tools retain their file
authorization and are not an alternate path for saving the current hosted object.

`editor.documents` exposes `new()`, `open(id?)`, `save(saveAs?)` and `state()`.
A managed mount with no initial document can become ready without creating an
object; the host or user can then choose New/Open. The editing runtime requires
an active document before document tool calls.

`editor.inspection.find(query, options?)` uses the UI's literal, wildcard and
regular-expression engine and returns ordered matches with document/revision
references. `locate(match, { focus?: boolean })` selects and scrolls to one
occurrence, including in read-only documents, without forcing keyboard focus.
`replace(result, replacement, index?)` uses the native replacement expression
rules and returns the replacement count; omitted index replaces the original
match set in one transaction. Edits or document replacement invalidate old
results. Host business values must be escaped according to the native
replacement syntax; the SDK does not introduce field-filling semantics.
Search scope and supported patterns are identical to the existing UI.

`editor.annotations` supplies document-local `setRules(source, rules)`,
`setRanges(source, ranges)`, `registerChecker(source, checker)`, `remove(source)`,
`refresh()`, `diagnostics()`, `errors()` and `onChange(listener)`.
Explicit ranges carry the inspection snapshot's document/revision reference.
Ranges map through edits; rule-based results recompute. Rules accept a regular
expression, optional message/severity, and background/color/underline styles.
An optional capture and allowed-values catalog can identify unknown values.
An editor-local checker receives a snapshot with text, character-to-document
positions and blocks plus an AbortSignal, and returns range annotations.
It can parse malformed, nested or cross-paragraph constructs; no business grammar
is built in. Stale asynchronous results are discarded and checker errors remain
observable through `errors()`/`onChange`. Diagnostics are advisory and cannot
prevent ordinary save/export. Decorations remain independent of diagnostics.

Configure reusable host-provided checkers in `host.checkers`; they are installed
anew for each document. Ad-hoc registrations are cleared when the document is
replaced. View annotations work in read-only documents and do not enter document
JSON, DOCX, ordinary copying, print or export; they do not dirty the document or
add history entries. Register/change/remove annotations through the SDK rather
than inserting marks, placeholder nodes or DOM content into the document.

`insert_image` and `insert_picture` accept either the existing `url` or
`source: { path }` / `source: { asset }`. Hosts implement the optional
`services.readImageSource` for asset references. The default Node service handles
local paths under canonical read roots or explicit file grants, using manual
insertion's image validation and embedding behavior. Node consumers can reuse
`readAuthorizedImage(access, path)`. The model does not carry the image bytes.

Qt hosts call `setServiceHandler(name, handler)` to override a service and
`setServiceEnabled(name, enabled)` to enforce availability. An empty handler
restores the default. Complete on the GUI thread with a `result` or `error`
JSON-RPC member; cancellation is an ordinary result and never requests fallback.
For managed storage, set `DocsQtOptions.documentHost` to a configuration with
`enabled: true`, optional `capabilities` and `autoSave`, then register the lifecycle
service handlers above. Binary `data` is transported as `{ base64 }`.
Set `documentCheckers` to source names and provide a `checkDocument` service
handler taking `[source, snapshot]` and returning range annotations. The host
can implement a complete parser without passing JavaScript functions across Qt.

`callSdk(operation, arguments, completion)` calls the same public browser methods.
Operations are `snapshot`, `find`, `locate`, `replace`, `documents.new/open/save/state`
and `annotations.setRules/setRanges/remove/diagnostics/errors/refresh`.
Native calls use JSON-RPC result/error replies and have a 30-second reply timeout.
Trusted Qt hosts can `grantFile(path, read, write, completion)` and `revokeFile`;
those permission-changing calls are not renderer/Agent services.

## Native ribbon contributions

`editor.ui.ribbon` exposes the editor's own ribbon to every embedding host.
It accepts declarative data and emits action IDs; it does not contain host
business operations, execute scripts, or require an Agent/model service.

- `tabs` appends new tabs, each containing labeled groups and controls.
- `groups` appends groups to a native tab identified by `tabId`.
- `quickAccess` appends controls after the native quick-access buttons.
- `assistantButton` customizes the native assistant entry in Home using optional
  `label`, `icon` and `visible` fields. Omitted fields retain the native defaults;
  `visible: false` hides only this entry, leaving the other AI tools available.
  The label also names its ribbon group. The icon uses the same raster data URL
  validation as contributed controls and the native assistant's 26px canvas.
  Clicking retains the existing assistant/Harness callback; it does not emit a
  contributed ribbon action or change the Agent implementation.

```ts
editor.ui.ribbon.set({
  documentToken: editor.documents.state()?.documentToken ?? null,
  assistantButton: { label: 'Workspace assistant', icon: assistantIconDataUrl, visible: true },
  // Include the rest of the current tabs/groups/quickAccess snapshot, if any.
})
```

This follows the same document-session lifecycle as other ribbon configuration:
`set` replaces the complete snapshot, `reset` restores defaults, and opening or
replacing a document clears the configuration. Reapply it with the new document
token. Qt hosts pass the same JSON through `callSdk("ui.ribbon.set", ...)`.

All three locations support `type: 'button'` with an `actionId`, and
`type: 'menu'` with menu `items`. Menu nodes use `action`, `group` or `submenu`;
actions have an `actionId`, while groups/submenus contain `items`. Every node
has a unique `id`, a plain-text `label`, and optional `visible`/`enabled`
booleans. Controls also accept `tooltip` and an optional PNG/JPEG/GIF/WebP
base64 data URL `icon` (up to 131072 characters). Remote URLs, SVG/HTML, custom
CSS, executable callbacks in configuration, and unknown properties are rejected.
Icons follow the target tab's native size: 22px in Home (matching Convert/Styles),
28px in other built-in and custom tabs, and 16px in the quick-access area.
Captions, spacing, density and dropdown chevrons use
the same native styles and glyphs. Omitting an icon uses a native generic glyph;
quick-access controls retain their accessible label and tooltip. Host labels are supplied in the
desired language; they are not added to the editor's translation dictionaries.

Ordinary extension buttons can also supply `pressed?: boolean`. Omit it for a
normal action button; `false` and `true` render a toggle button in its released
and pressed states, with native selected styling and `aria-pressed`. This works
in custom tabs, appended native-tab groups and quick access, including compact
and light/dark modes. The host owns the state: after opening a panel, submit the
complete configuration with `pressed: true`; after closing it from any entry
point, submit `pressed: false` with the same control ID and current document
token. Clicking only emits the existing action; it does not change `pressed`
automatically. A failed/pending host action therefore does not falsely select
the button. Keep its label stable between states. Menu buttons retain their
existing `aria-expanded` behavior and do not accept `pressed`.

```ts
{ type: 'button', id: 'tools-panel', label: 'Tools panel',
  actionId: 'extension.toggle-panel', pressed: panelOpen }
```

```ts
const stopActions = editor.ui.ribbon.onAction((event) => {
  // Dispatch against event.document/event.documentToken, not a later active file.
  application.handleAction(event)
})
const stopState = editor.documents.subscribe((state) => {
  editor.ui.ribbon.set({
    documentToken: state?.documentToken ?? null,
    tabs: [
      {
        id: 'extension.tools',
        label: 'Tools',
        groups: [
          {
            id: 'tools',
            label: 'Tools',
            items: [
              { type: 'button', id: 'inspect', label: 'Inspect', actionId: 'extension.inspect' },
            ],
          },
        ],
      },
    ],
    groups: [
      {
        tabId: 'view',
        id: 'view-tools',
        label: 'Tools',
        items: [
          {
            type: 'menu',
            id: 'actions',
            label: 'Actions',
            items: [
              { type: 'action', id: 'refresh', label: 'Refresh', actionId: 'extension.refresh' },
            ],
          },
        ],
      },
    ],
    quickAccess: [
      { type: 'button', id: 'quick-inspect', label: 'Inspect', actionId: 'extension.inspect' },
    ],
  })
})
// On teardown: stopState(); stopActions(); editor.dispose().
```

The exported `DOCS_RIBBON_BUILTIN_TABS` lists stable, language-independent native
tab IDs: `home`, `insert`, `draw`, `design`, `layout`, `references`, `mailings`,
`review`, `view`, `tableDesign`, `tableLayout`, `pictureFormat`, `shapeFormat`
and `headerFooter`. Contextual tabs retain their native visibility conditions.
`file` is a menu, not a contribution target; use `ui.fileMenu` for it. Custom
tabs cannot use reserved native IDs. Native controls and their ordering remain
intact. Invisible or empty custom tabs/groups/menus are omitted. Removing,
hiding or disabling the selected custom tab returns to Home. Controls inherit
disabled ancestors. Buttons use native theme, density, tooltip and focus styles;
menus share native keyboard navigation, nested-menu behavior and dismissal.

`set(configuration)` atomically replaces only the extension snapshot;
`reset()` removes all ribbon contributions. Both preserve document content,
history, dirty state, save behavior and native shortcuts. Each snapshot has at
most 512 nodes and eight levels of nesting; IDs/action IDs are 1–128 characters
and labels 1–256. Updates use the same document-session token rules as the file
menu: switching/reopening documents clears contributions and rejects stale
updates/actions. Use `null` with no active document. Action subscriptions survive
document replacement and return an unsubscribe function; disposal releases them.

Actions supply `{ itemId, actionId, location, tabId, groupId, documentToken,
document }`, where `location` is `tab` or `quickAccess`; quick-access actions have
null tab/group IDs. They report document identity/state, not a captured text
selection. Browser actions that need the current selection can synchronously
capture `editor.runtime.capture()` and use that scope for subsequent operations.
Host operations and SDK document commands keep their existing authorization and
read-only policies; showing a button does not grant editing permission.

Qt uses `callSdk("ui.ribbon.set", configuration, completion)` and
`callSdk("ui.ribbon.reset", {}, completion)` with the same JSON shape. Subscribe
to `ribbonActionTriggered(actionId, context)` for actions and
`documentStateChanged(state)` to refresh contributions. This uses the existing
QWebChannel JSON-RPC path; no injected JavaScript or native menu bar is needed.

This SDK currently embeds Docs. Other ForaOffice editors do not yet expose this
contract; their engine-specific objects are not part of the public interface.

## Host file menu

`editor.ui.fileMenu.set({ documentToken, items })` atomically replaces the internal
File menu. Its button stays immediately before the toolbar Save button, including
embedded macOS editors. `reset()` restores the default menu. An empty `items`
array intentionally leaves the menu empty. No editor remount or DOM/CSS injection
is involved. Menu changes do not modify content, history, dirty state, automatic
saving or keyboard shortcuts.

The File button and menu items share themed keyboard focus indicators. Pointer
activation keeps normal mouse styling, including after a native dialog returns.
Keyboard navigation and focus return follow the
[WAI-ARIA menu-button pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/).
These interactions are owned by the SDK and require no host CSS overrides.

Obtain the token from `editor.documents.state()?.documentToken ?? null`.
`editor.documents.subscribe(listener)` immediately reports current state and
subsequently reports changes to identity, name, path, dirty or read-only state.
It returns an unsubscribe function. A token identifies an editor document session,
not a storage ID or content revision: reopening the same object or adopting a
different object invalidates the old token and clears its menu. Ordinary edits,
renaming within an identity and Save As with `adopt: false` retain the token.
Use `null` when there is no document. Stale menu updates are rejected; re-evaluate
the menu for the current session rather than blindly retrying old updates.

```ts
const stopActions = editor.ui.fileMenu.onAction((event) => {
  // Host business code dispatches event.actionId against the captured
  // event.document and event.documentToken, not whichever document is now open.
  host.handleAction(event)
})
const stopState = editor.documents.subscribe((state) => {
  editor.ui.fileMenu.set({
    documentToken: state?.documentToken ?? null,
    items: [
      {
        type: 'group',
        id: 'storage',
        items: [
          { type: 'command', id: 'new', command: 'new' },
          { type: 'command', id: 'open', command: 'open' },
          { type: 'command', id: 'save', command: 'save' },
          { type: 'command', id: 'save-as', command: 'saveAs' },
        ],
      },
      {
        type: 'action',
        id: 'publish',
        actionId: 'host.publish',
        label: 'Publish…',
        enabled: !!state && !state.readOnly,
      },
    ],
  })
})
// On host integration teardown: stopState(); stopActions(); editor.dispose().
```

Each node has a unique `id` (across the whole tree), optional `visible` and
`enabled` booleans (both default true), and the following type-specific fields:

| type      | Fields                      | Behavior                                                                    |
| --------- | --------------------------- | --------------------------------------------------------------------------- |
| `command` | `command`, optional `label` | Executes an existing editor command; omitted label uses editor translations |
| `action`  | `actionId`, `label`         | Emits a host action; never executes an editor command as a fallback         |
| `group`   | `items`, optional `label`   | Groups entries; empty/hidden groups are omitted                             |
| `submenu` | `items`, `label`            | Opens a nested menu; empty/hidden submenus are omitted                      |

Commands are `new`, `open`, `save`, `saveAs`, `exportPdf`, `exportHtml`,
`exportMarkdown` and `exportImages`. New/open retain the existing replacement
confirmation and document-host callbacks. Save/Save As use the existing queue,
serialization and hosted `saveDocument`; exports use the existing output services.
Command policies are rechecked on activation, so `enabled: true` cannot grant
permission. Hiding/disabling a menu item is presentation, not a replacement for
document capability or service policy. Built-ins do not emit host actions.

Use custom actions for rename, publish, version history and application-owned
close. The menu contract does not add those business operations to the editor.
Changing a menu item's label does not rename the document. In Qt, call the
widget's existing `close()` to retain its unsaved-change check. Async host work
must keep its captured target; clearing a menu cannot undo a business operation
already started by the host.

Updates use complete snapshots with stable IDs; change `label`, `visible` or
`enabled` and submit again with the current token. Hidden/disabled ancestors also
prevent activation of descendants. Labels are plain text; executable content,
unknown commands and ambiguous nodes are rejected. Trees support at most 256
nodes and eight levels; IDs/action IDs are 1–128 characters and labels 1–256.
`onAction` returns an unsubscribe function and supplies
`{ itemId, actionId, documentToken, document }`. This instance-level dispatcher
survives document changes, while document-specific trees and tokens do not.
Editor disposal clears state and all action/state subscriptions; retained handles
reject further calls.

Qt uses the same operations through `callSdk("ui.fileMenu.set", config, done)`
and `callSdk("ui.fileMenu.reset", {}, done)`. Connect `menuActionTriggered` for
custom actions and `documentStateChanged` for state updates (JSON null with no
document); the first state notification follows `ready`. Slots and completions
run on the GUI thread. The existing QWebChannel JSON-RPC transport is reused.

`hosts/qt/examples/file-menu.cpp` is a complete, compilable integration example
covering new/open/save/save-as/rename/publish/history/export/close. Its business
actions log their captured target for the embedding application to implement.
Build with `-DFORAOFFICE_DOCS_QT_BUILD_EXAMPLES=ON`, then run
`docs-qt-file-menu-example --package <sdk> --workspace <documents> --state <private-state>`.
No native menu bar is required. Browser controller/view/bridge tests and the
real native `docs-qt-public-sdk` test cover the contract and service reuse.

The menu button and submenus follow the
[WAI-ARIA menu-button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) and
[menu keyboard](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) patterns.

## Standard MCP

The Node entry `@foraoffice/docs-sdk/mcp` uses standard MCP over stdio. The owning
host first authorizes and binds a document/action, then supplies these variables
to the child process:

```text
FORAOFFICE_DOCS_ENDPOINT=<host bridge URL>
FORAOFFICE_DOCS_TOKEN=<host-owned document grant>
```

The host creates that grant using `createDocsHostBridge` from
`@foraoffice/docs-sdk/services`, with a binding registered through
`editor.commands.bindScope(bindingId, scope)` and a command endpoint transported
over its own native IPC. Close the grant when its authority ends; do not place
its token in document text or tool results. Public Agent traffic uses standard
MCP; the bridge is local host IPC, not an alternative Agent protocol.

`examples/mcp-client.mjs` lists tools and reads the bound live document without a
model. `createDocsMcpServer({ endpoint, bindingId?, version })` is also available
for hosts that own a standard MCP transport directly.

### Host-controlled HTTP MCP in Qt

After `DocsQtEditor::ready`, call `startMcp(completion)` to authorize the current
document and start a loopback HTTP MCP endpoint. No action handler, AI-button
interaction, model or conversation is required. A ready managed mount without
an active document reports an error; create/open a document first.

```cpp
editor.startMcp([](const QJsonObject& reply) {
    if (reply.contains("error")) return; // Handle the normal JSON-RPC error.
    const auto connection = reply.value("result").toObject().value("connection").toObject();
    // Give connection to a compatible external MCP client through trusted host IPC.
});
```

The JSON-RPC result contains `{ status: "running", connection }`. `connection`
contains `url`, `transport: "streamable-http"`, `headers` (including its Bearer
credential), an opaque runtime `documentId`, and `protocolVersions`.
Configure a standard client with the URL and headers. Never publish the
credential in document text, tool results or logs. `mcpState(completion)` returns
the same running connection or `{ status: "stopped" | "failed" }`.
`mcpStateChanged(state)` reports status and optional document identity without
credentials. All native methods/completions use the GUI thread.

`stopMcp(completion)` revokes access without closing the editor and is safe to
repeat. Repeated start for the same active document reuses its grant. Document
replacement, close checks, view disposal and backend/renderer failure revoke
access; a replacement document requires an explicit new start. A canceled close
check may already have revoked access. A connection binds when enabled, even
if its first client connects later; it never follows a newly opened document.
Unsaved edits remain live, and existing read-only, draft, save, hosted storage
and file-permission rules apply. Stopping does not roll back committed work.

The service binds `127.0.0.1` on an allocated port and uses the installed MCP SDK
1.32.1 transport for revisions `2025-03-26`, `2025-06-18` and `2025-11-25`.
Protocol sessions use the SDK's standard initialization and session headers;
each session has independent document caller state. Terminating one session
does not revoke the host grant. This is not a claim of support for the changed
`2026-07-28` transport, legacy SSE endpoints, or remote network publication.

`examples/mcp-http-client.mjs` accepts the connection object on stdin, discovers
tools and reads the live document using the standard client. It prints no
credentials and needs no model. The host supplies any external client's own
configuration format and conversation lifecycle.

Node hosts can reuse `createDocsHttpMcpServer({ version, endpoint, bindingId,
documentId, releaseScope })` from `@foraoffice/docs-sdk/services`. Bind a captured
runtime scope before creating the service; release/close the service on document
replacement and host disposal. `service.connection` has the same connection
shape; `service.close()` is idempotent. The existing `/docs` command bridge is
private host IPC and is never the HTTP MCP URL.

## Resource helpers

`createDocsResourceTools({ attachments?, knowledge?, runCli? })` composes the
shared attachment/knowledge/Office CLI executors over host-owned services. Pass
a stable provider through `createExternalDocsHost`'s fourth argument. Replacing
or withdrawing that provider revokes pending reads. Its current source lists
may change without replacing it; removed sources cannot publish late data.

These four tool contracts remain discoverable when absent, and invocation then
reports unavailable. Their implementation is optional for a particular host:
the SDK does not create a corpus, attach files or install a CLI implicitly. A
provided `runCli` must run the bundled, bounded Office CLI with file grants and
open-file protection. It is not a shell executor. Provider/model CLI commands
are refused by the editor boundary.

`createDocsResourceServices` provides the portable file-backed implementation.
Configure read/write roots and private storage, then set the approved attachment
and knowledge selections. Selection does not grant access to arbitrary files.
The CLI accepts bounded argument arrays, enforces the same file policy and
refuses in-place changes to the host's open document. Cancellation waits for the
child process to close and preserves uncertain file effects.

The former inference tools are described in `get_editor_capabilities` as Harness
workflows: web/image search, image generation, media analysis and document
writing. The Harness performs those steps and supplies ordinary content/images
or ordered draft updates. They are not model endpoints in the editor.

## Node file processing

`createDocsFileSession`, `createDocsFileServices` and `createDocsAssetServer` are
independent of Electron. `examples/files.mjs` demonstrates byte-preserving Word
open/save in an authorized directory. A file-level operation does not see a
view's unsaved changes; use the live runtime to edit an open document.

`createDocsExportServices` shares PDF merging/internal links, HTML and Markdown
media export, image export and owned temporary files across hosts. Inject only
native dialogs and live-view PDF bytes. `createDocsMailMergeServices` shares
CSV/XLSX recipient parsing and merged-file persistence; the editor builds the
merged Word content. Both enforce exact dialog approvals and private-state
exclusion. Their typed options are exported from `services`.

## Qt integration

`hosts/qt` contains the reusable `ForaOfficeDocsQt` CMake target, widget header and
sample executable. It requires Qt 6.8 or later with Widgets, WebEngineWidgets,
WebChannel, Network and PrintSupport. On Windows use the matching MSVC toolchain:

```text
hosts\qt\build-windows.cmd BUILD_DIRECTORY QT_MSVC_PREFIX
```

Run the resulting `docs-qt-host` with `--package` pointing to this SDK directory,
`--node` to a Node executable, `--workspace` to the authorized documents folder
and `--state` to private host storage. Repeat `--attachment FILE` and
`--knowledge FILE` to select resources under the authorized workspace. The sample
supports opening/manual editing, shared runtime tool calls, Word persistence,
native file dialogs, clipboard, image assets, file-backed resources, the bounded
CLI, new-file creation and owned-backend lifecycle. It requires the normal Qt runtime
deployment produced by `windeployqt` or supplied by the embedding application.

`DocsQtEditor` is a reusable QWidget. Its native host owns the Node child process,
resource scheme and dialogs. `setCreateWordHandler` supplies a new-view factory;
the sample wires it and acknowledges the actual first Word save. The optional
`setOpenFileHandler` opens other generated formats in the embedding application's
viewer. Without it those files are created successfully with `opened: false`.
`setActionHandler` forwards editor-originated actions and scoped grants to an
external conversation; `--harness-stdio` demonstrates that handoff without a model.

Qt hosts use `setInstructionResolver(InstructionResolver)` for the same optional
built-in instruction hook. Its request is the JSON representation of
`DocsAiInstructionRequest`; it includes stable operation IDs and translation
language codes, independent of the Qt/editor UI language. Complete on the GUI
thread with the existing `Completion` result/error envelope:

```cpp
editor.setInstructionResolver([](const QJsonObject& request,
                                foraoffice::DocsQtEditor::Completion done) {
    if (request.value("operationId") == "translate_selection") {
        const auto language = request.value("parameters").toObject()
                                  .value("targetLanguage").toString();
        done({{"result", QStringLiteral("Translate only the selected text into ") + language}});
    } else {
        done({{"result", QJsonValue::Null}}); // editor default
    }
});
```

An empty resolver restores defaults. For asynchronous configuration or a host
dialog, retain the invocation `request.id` to cancel with
`cancelInstructionResolution(actionId)`. Observe
`instructionResolutionCanceled(actionId)` to stop host work; late and duplicate
completions are ignored. Replacing the native resolver cancels its outstanding
requests. A failure/cancellation uses `{ "error": { "message": "...",
"data": { "errorCode": "canceled" } } }`, rather than returning null.
Resolution itself creates no extra grant. Successful actions still flow through
`setActionHandler` with the original binding and the resolved instruction snapshot.

The Qt adapter runs process startup, initialization, stdio parsing and request
tracking on an internal worker thread. These steps progress while the GUI event
loop is busy. Backend initialization has a 30-second timeout. WebEngine,
dialogs, printing and live document execution stay on
the GUI thread; backend initialization alone does not mean the editor is ready.
Start the widget before synchronous workbench construction to overlap backend
initialization with that work. Ordinary view disposal requests asynchronous
backend shutdown. The worker closes stdin, then escalates to terminate after
five seconds and kill after another two seconds if needed. Application exit
joins the worker after process cleanup; this is not a hard exit-time guarantee
if the operating system itself blocks process creation or termination.

Native regressions are opt-in: configure `hosts/qt` with
`-DFORAOFFICE_DOCS_QT_BUILD_TESTS=ON`, build, then run
`ctest --test-dir BUILD_DIRECTORY --output-on-failure`. Tests additionally need
Qt Test and Node on PATH. `DOCS_TEST_PACKAGE_ROOT` can select the built SDK;
checkout and packaged layouts are detected by default. The tests cover real
backend initialization with GUI event processing paused, nonblocking widget
disposal, and worker cancellation/crash/late-reply behavior. This controlled
pause checks thread independence; measure normal startup separately.

Qt printing uses the current paginated editor view, native printer enumeration,
the system print dialog and PDF bytes. The driver supports scale 1, advertised by
`supportsPrintScale: false`; the renderer therefore avoids an inverse print zoom.
PDF/HTML/Markdown/image export and mail merge use the shared Node services.
Native printer cancellation after driver submission has an unknown outcome.

Host-specific conversion remains explicit: the Qt sample opens `.docx` files.
Legacy `.doc`, `.odt`, `.hwp` import and HTML/MHT `altChunk` display conversion
remain integrations supplied by the host; the Electron application retains its
existing converters. Unconverted chunk parts remain preserved in the DOCX
package. The SDK package does not install or modify a DIGspace application.

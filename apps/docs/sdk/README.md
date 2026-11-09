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

The optional `harness.submit(action)` callback forwards a user action to the
embedding application's external conversation. It is not needed for ordinary
tool execution. The application owns any conversation, model request or task
orchestration.

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

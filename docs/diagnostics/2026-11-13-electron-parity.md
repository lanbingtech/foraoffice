# Electron verification after Agent neutralization

## Scope and test boundaries

The audited range is `790247a6..91dda347` on
`feat/editor-runtime-decoupling-v0.12.852`: 18 non-merge commits after the neutral
Agent boundary. Verification runs locally on Windows with isolated profiles,
documents and authorization directories. No external test environment is changed
and no model/provider request is made.

Two distinct Electron paths are exercised:

- **Electron SDK:** the existing browser SDK assertions run unchanged through a
  selectable launcher in genuine Electron BrowserWindows. The fixture declares
  `host.kind = 'electron'` and mounts the public SDK. Its storage/services and
  external Harness callbacks are fixture implementations, so these tests prove
  editor/UI/SDK behavior in Electron, not production filesystem IPC.
- **Native Electron:** the freshly built normal shell loads the production
  `genoffice-app://docs` renderer, preload and main process. An MCP SDK `Client`
  with `StreamableHTTPClientTransport` calls the real shell MCP server. Real
  DOCX files are saved and reopened. This covers production IPC, media policy,
  CSP and native selection binding independently of the SDK fixtures.

The independent Node backend is tested separately because normal desktop
Electron does not route every operation through that backend. Its tests are not
counted as native Electron IPC evidence.

The table repair is implemented in shared `renderer/editor/extensions.ts` and
`renderer/ai/{doc-utils,protocol,tools}.ts`. Operation identifiers live in
`shared/editor-action.ts`, with scope binding and resolution in the shared
`renderer/runtime/{editor-actions,docs-runtime}.ts`. Both Electron paths execute
these implementations. Qt bridge files translate transport/lifecycle calls;
they do not supply an alternate table renderer or selection-replacement engine.

Actual SDK engine evidence records Electron **43.8.3**, Chromium
**150.0.7871.250**, Node **24.22.0**, and `platform: win32`. SDK windows use
Electron's offscreen renderer, with context isolation and renderer sandbox
enabled and Node integration disabled. Offscreen rendering supplies compositor
frames for genuine screenshots without requiring visible test windows. Native
tests use the ordinary shell, not the SDK test bootstrap.

## Per-change acceptance matrix

| Commit     | Repair or capability                                  | Electron acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `68816659` | Qt backend lifecycle off the GUI thread               | Qt QProcess implementation is adapter-specific. Native Electron startup, MCP operation and shutdown exercise its existing main/preload lifecycle; no QProcess emulation is claimed.                                                                                                                                                                                                                                   |
| `2a5a950c` | Neutral hosted documents, inspection and annotations  | SDK: pathless save/save-as, read-only policy, search/regex/navigation, annotation state, disposal/remount and document lifecycle. Native: real file save/reopen and embedded media. Electron printing compares annotated/clean output.                                                                                                                                                                                |
| `03eb6119` | Neutral HTTP MCP specification                        | Documentation-only commit; native Electron uses the standard MCP SDK client against its actual shell server.                                                                                                                                                                                                                                                                                                          |
| `7a016a48` | Host-controlled Qt HTTP MCP                           | Qt start/stop API is adapter-specific. Native Electron equivalent is its shell MCP implementation, tested through real document tools and caller-scoped selection. Shared Node backend lifecycle is verified separately.                                                                                                                                                                                              |
| `b2e353b0` | data/blob reads in host CSP                           | Native production renderer fetches data/blob URLs, decodes the image with no CSP violations, inserts through public `insert_image`, and verifies DOCX media bytes and reopened image.                                                                                                                                                                                                                                 |
| `bd651e81` | File-grant propagation to resource services           | Independent real Node process: exact read-only grants enable attachment reads, sibling files remain denied, read-only grants cannot save, and revocation denies subsequent reads. Not inferred from injected SDK services.                                                                                                                                                                                            |
| `7dad8920` | File-menu extension state and actions                 | Same SDK assertions exercise registration, updates, visibility, capability filtering, disabled actions, context and disposal.                                                                                                                                                                                                                                                                                         |
| `a3a250b6` | Embedded versus standalone window chrome              | Electron SDK checks no reserved window-control gaps or drag regions, in light/dark themes on actual Windows. Native shell retains standalone tabs and ribbon chrome.                                                                                                                                                                                                                                                  |
| `58c32ac3` | Pointer versus keyboard menu focus                    | SDK checks pointer-open appearance, arrow navigation, keyboard outline, Escape and focus return for File and extension menus.                                                                                                                                                                                                                                                                                         |
| `df41b657` | Neutral ribbon extensions                             | SDK exercises tabs/groups/buttons/submenus/quick access, compact mode, updates, invocation and cleanup.                                                                                                                                                                                                                                                                                                               |
| `006eec0a` | Effective managed AutoSave state                      | SDK checks initial host preference, user toggle, blur-save behavior, close state, and read-only disablement.                                                                                                                                                                                                                                                                                                          |
| `7bffd1a0` | Host-controlled pressed buttons                       | SDK checks live `aria-pressed`, active class and painted state without rebuilding the document editor.                                                                                                                                                                                                                                                                                                                |
| `2cc97518` | Native/extension ribbon metrics                       | SDK compares real computed dimensions, spacing and styles in full/compact modes and light/dark themes.                                                                                                                                                                                                                                                                                                                |
| `e40a57d9` | Home versus Review icon metrics                       | SDK compares Home extension glyphs to native controls, including the 22px inner glyph of the Home control.                                                                                                                                                                                                                                                                                                            |
| `54bd9942` | Selection instruction popover for external agents     | SDK checks close/Escape/outside cancellation, explicit confirmation, empty-input guard, document replacement and frozen selection. Native checks actual selection overlay/cancel/queue and excludes queue metadata from DOCX.                                                                                                                                                                                         |
| `4659c139` | Host assistant-button presentation                    | SDK checks label/icon/group update and reset while default summarize behavior and actions remain intact.                                                                                                                                                                                                                                                                                                              |
| `b5105a06` | Whole-table revisions and exact cell text replacement | Both Electron paths create a tracked whole-table replacement, verify all four display modes, read exact selected cell text, move live selection, replace only the captured text, preserve neighbors/revisions, save and reopen. Native tools travel through production IPC/MCP.                                                                                                                                       |
| `91dda347` | Neutral operation IDs and instruction resolution      | SDK runs identical English and Chinese suites: proofreading, translation, synonyms, comments, revision summary, naming, F7/context/ribbon/File entrances, structured translation parameters, default/custom instructions, free-input bypass, immutable snapshots and three late-resolution cancellations. Cell text remains the selected scope. Qt bridge cancellation/reentrancy implementation is adapter-specific. |

## Newly reproduced shared-backend defect

The existing Node-host integration failed twice before any code change: a
`document.bindAction` concurrent with `document.releaseAllActions` could return a
grant instead of the expected revoked-during-creation error. The release-all
handler awaited MCP transport shutdown before marking pending grants revoked.
A pending bridge could finish during that wait.

The fix invalidates pending grants and removes published bridges before the
first asynchronous wait, then closes transports concurrently. It changes only
`src/services/node-host.ts`; there is no Qt/Electron conditional. The existing
regression now also checks that the revocation response accounts for the pending
grant, for both single and all-action revocation.

JSON-RPC batch processing remains concurrent, and responses are correlated by
ID. This follows the [JSON-RPC 2.0 batch contract](https://www.jsonrpc.org/specification#batch),
which permits concurrent tasks and arbitrary response order; no host-side
ordering convention or private protocol is added.

## Print evidence correction

The original Qt PDF comparator accessed `PageRender.png`, although the renderer
returns encoded PNG bytes in `PageRender.data`. It therefore compared arrays of
undefined values. That historical passing assertion did not establish pixel
parity. The shared test renderer now reads the actual bytes and PDF text, checks
known authored content, and retains both PDFs and rendered page images. The
native Qt comparator was rerun successfully with this corrected assertion.

The stricter Electron comparison exposed a real difference previously hidden by
that assertion: annotation spans split printed text into separate runs, whose
rounded PDF origins changed 24 antialias pixels in the fixture. This diagnosis
used decoded PNG pixels and PDF content streams; it was neither a blank-page
comparison nor an arbitrary screenshot tolerance.

The shared annotation ProseMirror plugin now suspends only its view decorations
during the standard HTML `beforeprint` event, then redraws the current plugin
state on `afterprint`. It does not dispatch a transaction, remove document marks,
discard diagnostics, or introduce a host callback. Listeners belong to the
editor's own window and are removed with the view. This implements the
[HTML printing lifecycle](https://html.spec.whatwg.org/multipage/timers-and-user-prompts.html#printing)
at the shared view boundary. CSS-only neutralization was insufficient to remove
the fragmented text runs.

The annotation regression first failed before implementation. Its 12 checks now
pass, including decoration suspension/restoration, concurrent finding updates,
reset during printing, unchanged content and absence of undo entries.

## Reproduction and evidence

Build from the repository root:

```powershell
npm run build -w @genoffice/docs
npm run build -w @genoffice/shell
npm run build:sdk -w @genoffice/docs
```

Use the same SDK tests with the actual Electron launcher. The Qt-only native
executable test is excluded explicitly:

```powershell
$env:FORAOFFICE_SDK_TEST_HOST = 'electron'
node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts e2e/docs-sdk-integration.spec.ts e2e/docs-sdk-ai-operations.spec.ts e2e/docs-sdk-table-selection.spec.ts --grep-invert 'the real Qt public SDK' --reporter=list --output=apps/docs/out/diagnostics/electron-parity/results
Remove-Item Env:FORAOFFICE_SDK_TEST_HOST
```

With the variable unset, the launcher preserves the browser target. Chrome's
four corresponding cases also pass. Only that existing browser target simulates
other `navigator.platform` values; the Electron target uses its real platform.
No macOS/Linux Electron run is claimed.

Native desktop and independent backend:

```powershell
node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts e2e/docs-electron-native-regressions.spec.ts --reporter=list --output=apps/docs/out/diagnostics/electron-parity/native-results
node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts e2e/docs-node-host.spec.ts --reporter=list --output=apps/docs/out/diagnostics/electron-parity/shared-backend
Push-Location apps/docs
node ../../node_modules/vitest/vitest.mjs run tests/docs-node-host-grants.test.ts --maxWorkers=1
Pop-Location
```

Generated profiles, fixture DOCX files, engine JSON, printed PDFs and structured
AI actions live under the ignored
`apps/docs/out/diagnostics/electron-parity/` directory. Engine evidence is attached
to each SDK test result; AI request/action snapshots are additionally retained
under `ai-operations/en.json` and `ai-operations/zh.json`. Native runs retain their
own production renderer URL and runtime identity. No generated build or profile
is committed.

The original four-case SDK run is retained in `results/`. Final focused replays
after the shared print correction are in `print-validation/` (PDFs, real PNGs and
engine identity) and `ai-operation-results/` (all built-in AI entrances). These
replays retain every original business assertion. Browser controls are in
`browser-integration-control/` and `browser-ai-control/`.

Final verification:

- Electron SDK: **4 passed**; the final affected integration replay and both
  language replays also passed after the printing correction. Each language
  records **12 submitted actions, 14 resolver requests and 3 late aborts**,
  including actual Review comment/revision operations. The final nonempty
  printed pages have equal PNG bytes and decoded pixels.
- Normal desktop Electron: **2 passed** (16.3s), including real MCP/IPC and file
  round trips. Screenshots are retained under `native-results/`; isolated
  runtime/file evidence is in `tracked-table-vspFIC/` and
  `media-and-queue-5moZJq/` beneath the diagnostics directory.
- Independent Node backend: **2 passed** after the shared authorization fix;
  rebuilt SDK file-grant regression: **1 passed**.
- Shared annotation tests: **12 passed** after a reproduced printing regression.
- Native Qt SDK print control: **1 passed** with the final SDK, real nonempty
  PNG comparison and a known authored-text assertion. This exercises Qt
  separately; it is not included in the Electron count.
- Browser compatibility control: **4 passed**; the changed hosted integration
  case was also rerun after the print-helper extraction.
- Docs, shell and SDK builds, Docs typecheck, changed-file ESLint, strict type
  checking of all changed E2E files, formatting and whitespace checks passed.

Code and TypeScript reviews covered the source fix, genuine engine/IPC
boundaries, assertions and asynchronous resource ownership. Startup-failure
cleanup findings were corrected in the test launchers.

The SDK and native assertions establish behavior at the editor, submission,
scope/authorization, tool and saved-file boundaries. They intentionally use no
model request, so this report does not claim provider/model answer quality or
Qt-native driver/thread behavior was tested by Electron.

# Security Policy

<!-- Modified for ForaOffice from GenOffice security guidance. -->

## Reporting a Vulnerability

This policy covers [ForaOffice](https://github.com/lanbingtech/foraoffice), including
its Docs SDK and inherited desktop consumers. Do not send fork-specific reports
to GenOffice's upstream maintainers.

**Private-channel limitation:** as checked on November 13, 2026, GitHub private
vulnerability reporting is disabled for this repository and the maintainer has
not published a verified alternative private address. There is currently no
project-provided private reporting channel. Do not publish exploit details,
credentials or confidential documents in public issues.

For a sensitive report, withhold the details until the maintainer provides a
verified private channel. You may open a public issue asking
[@turbinefish](https://github.com/turbinefish) for a private contact, without
including the vulnerability, affected private data or a reproducer. This is a
channel request, not confidential report submission. The maintainer must enable
private vulnerability reporting in this repository's security settings or publish
a verified private address, test it, and update this section before claiming
private reporting is available. No response-time guarantee is made while that
channel is unavailable.

## Embedded Docs trust boundaries

The editor's public host/runtime contract is described in the
[SDK guide](apps/docs/sdk/README.md) and [integration overview](docs/docs-sdk-integration.md).
The embedding host is trusted to implement the services it injects. The SDK is not
a sandbox that protects a document from its own host application. The external
agent is a separate consumer of authorized context; it does not receive native
provider settings as part of the editor interface.

- **File services:** the provided Node services enforce canonical read/write roots,
  exact dialog-approved files and private-state exclusions. A resource selection
  is not an arbitrary filesystem grant. A host replacing these services must
  implement an equivalent authorization policy appropriate to its application.
- **Live authority:** runtime callers and captured scopes bind to a document
  generation and, when captured, a selection. Valid edits can map that selection;
  replacing a document does not retarget the old scope. Replacement, closure,
  revocation and disposal end the relevant authority and pending work.
- **Freshness:** stale body, revision or document-side state requires the
  appropriate fresh context read and reassessment. Do not automatically retry a
  stale edit against the current view or a different document.
- **Persistence:** save outcomes distinguish committed, pending and unknown file
  effects. Cancellation does not imply rollback. An outstanding draft must be
  explicitly finalized, retained or discarded before saving.
- **MCP:** host-controlled HTTP access uses loopback, an allocated port and a
  credential supplied through trusted host IPC. Keep credentials out of documents,
  logs and tool output. A protocol session and the host's document grant have
  different lifetimes; terminating a session does not by itself revoke the grant.
  Revoke host access on document replacement and disposal. The private command
  bridge is not a public MCP endpoint or a remote-publication mechanism.
- **Resources:** attachment, knowledge and bounded Office CLI helpers are optional
  host capabilities. The CLI helper is a file-operation allowlist, not a shell or
  a model/provider command executor. Removing resource authority must prevent late
  results from publishing through the old binding.
- **View controls:** authored document content, view annotations and AI context
  projection are different surfaces. A display/masking feature is not encryption
  or a blanket restriction on file-level CLI, MCP, exports or the host's access.

When evaluating an integration, review the actual host's storage, network,
printing, process and external-agent policies as well as these editor boundaries.
A browser or Qt embedding does not inherit Electron's sandbox configuration.

## Inherited desktop process security posture

The inherited Electron application windows use renderer lockdown:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every
  document window and tab view (docs, sheets, slides, pdf, markdown, shell, updater).
- Renderers reach the main process only through typed, validated IPC channels
  (payloads are schema-checked in the main process; sheets uses zod end to end).
- Every `shell.openExternal` call goes through a single shared gate
  (`@genoffice/electron-utils` → `safeExternalUrl`) that parses the URL and
  enforces a protocol allowlist (http/https; pdf link annotations additionally
  allow mailto). `file:`, `javascript:`, and custom schemes are always rejected.
- No API keys are hardcoded. AI requests are proxied through the signed-in
  account by default; user-supplied keys stay in the OS-level settings store.

## Threat Model: AI-Generated Layout Scripts (slides)

The slides AI can adjust slide layouts by emitting a small script that is
parsed with Acorn and evaluated by a constrained AST interpreter
(`apps/slides/src/renderer/ai/layout-script-interpreter.ts`). The source looks
like a small, synchronous subset of JavaScript for model compatibility, but it
is not passed to `eval`, `Function`, a VM context, a worker, or the JavaScript
engine as executable source.

**What the script can do by design:** read prototype-free JSON copies of
`els`/`canvas`, perform bounded arithmetic/control flow, use explicitly
implemented string/array/regular-expression/Math helpers, and call
`setBox/moveBy/resizeBy/setText/setStyle/setFill/setStroke/log`. Every edit
primitive validates its arguments (element existence, read-only flags, finite
numbers, hex colors) and writes only into an op buffer that is applied through
the same command pipeline as manual edits.

**Interpreter boundary:**

1. Identifiers resolve only in interpreter-owned lexical scopes seeded with the
   documented data and callables. There are no ambient globals, module loader,
   DOM, network, IPC bridge, timers, process APIs, or dynamic code primitives.
2. Property reads are dispatched by value type. Data objects expose own JSON
   fields only; arrays, strings, and regexes expose a small method allowlist.
   Host prototypes and function properties are never traversed, including
   through computed property names.
3. Calls accept only interpreter-created functions or explicit builtins. A host
   function obtained through a constructor/prototype chain cannot be
   represented.
4. Inputs and values crossing into edit primitives are recursively copied as
   JSON-like, prototype-free data. Errors discard all buffered operations;
   logs are capped.
5. Execution has statement/expression and call-depth limits to bound runaway
   loops or recursion. Regular expressions run on an interpreter-owned matcher
   with its own step budget (a supported subset; no native backtracking), so a
   catastrophic pattern cannot stall the renderer past those limits.

The Electron renderer sandbox remains defense in depth, but it is not the
layout-script security boundary. The interpreter is designed so a layout
script cannot obtain renderer capabilities in the first place.

If you find a way for a layout script to reach anything beyond the injected
primitives (network, storage, IPC channels not reachable by design, or the
main process), that is a vulnerability — please report it.

## Threat Model: Rendering AI-Generated HTML

Three pipelines render AI-generated or untrusted HTML in a hidden
`BrowserWindow`. Every window is treated as hostile content: full renderer
lockdown (`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`),
no preload script, no IPC surface. The slides hidden windows only load the
app's own renderer and print HTML (PDF export, print, headless export); the
AI-HTML-to-pptx conversion runs inside the slides renderer, never in a hidden
window. The HTML app's DOCX export and the docs altChunk conversion drive their
windows exclusively through `executeJavaScript` under a watchdog timeout
(`Promise.race` against a fixed timeout, then `destroy()`), so a page whose
scripts never yield cannot strand the hidden window. HTML→DOCX
conversion renders the page with scripts enabled and does not sanitize the
markup before conversion — the output is a document, not a sandbox escape;
report it as a vulnerability if you find a way from the converted page into
the main process.

## Out of Scope

- The cloud AI services this client talks to are operated separately and are
  not part of this repository; issues with them should be reported through the
  service provider's channels.
- Vulnerabilities that require an already-compromised machine or a modified
  binary. This includes the deliberate environment-variable override points
  for local development (`GSK_CLI_PATH`, `XLSX_SIDECAR_PATH`): setting them
  requires control of the process environment, which is equivalent to code
  execution on the machine.

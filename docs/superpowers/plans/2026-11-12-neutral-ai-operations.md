# Neutral AI operation instruction resolution

> **For agentic workers:** Use superpowers:subagent-driven-development for independent implementation tasks. Preserve unrelated edits and keep changes scoped to this contract.

**Goal:** Let any SDK host identify built-in editor AI operations and optionally
resolve their instruction, without encoding a host's configuration or workflow.

**Architecture:** Built-in UI callbacks carry a discriminated operation descriptor
alongside the existing default instruction. The action dispatcher captures the
existing document/selection authority before invoking an optional Harness callback.
The Qt adapter exposes the same contract over its existing native bridge.

**Tech stack:** TypeScript, React, ProseMirror, existing JSON-RPC Qt bridge, Qt/C++,
Vitest, Playwright.

## Public contract

- Stable identifiers: `proofread_document`, `proofread_selection`,
  `translate_document`, `translate_selection`, `suggest_synonyms`,
  `resolve_comments`, `summarize_revisions`, `name_document`, plus the existing Home
  shortcuts `summarize_document`, `polish_document`, `polish_selection`,
  `format_document`, `create_mind_map`.
- Translation parameters contain `targetLanguage`, the locale-independent
  language code already selected by the UI. Other operations carry empty parameters.
- Built-in submitted actions expose `operationId` and `parameters`. Free input
  and generic conversation focus have no operation descriptor.
- Optional `harness.resolveInstruction(request, signal)` receives the operation,
  default instruction and captured action/document/selection binding context.
  Null, undefined and blank results use the default; a nonblank result is preserved
  verbatim. Resolver errors refuse the action rather than silently bypass policy.
- Capture and bind before awaiting. Binding release/disposal cancels resolution;
  content changes while resolving cancel the stale request. Recheck document,
  authored state and Harness identity before submission. Cursor-only movement
  keeps the captured selection. Hosts may cancel through `commands.releaseScope`.
- Submit a snapshot of the resolved string and operation parameters. Do not
  consult mutable configuration again during execution. Free input bypasses
  resolution and retains its original text.

## Tasks and verification

- [x] Add public operation/request types and dispatcher regression tests.
      Verify metadata, fallback, errors, immutable snapshots, cell selection,
      document replacement, content edits, cancellation, revocation and disposal.
- [x] Implement the dispatcher and thread descriptors through Review, context
      menu, Tools/F7 and naming entries. Retain native Agent defaults and free input.
      Verify multilingual UI and identical identifiers across equivalent entries.
- [x] Add neutral Qt instruction-resolution handler and bridge cancellation;
      update TypeScript/native tests and generic host documentation.
- [x] Run targeted/wider SDK regressions, type checks, changed-file lint,
      embedded SDK build, browser E2E and relevant native Qt checks.
- [x] Review source, tests and docs; commit reviewed changes on the current
      branch. Check status/untracked files and retain generated output under `out/`.

The SDK does not store templates, introduce a settings service, name an external
product, or require model/provider conventions. Existing grants remain the
authority for document tools.

## Verification result

- Nine TypeScript test files: 157 checks passed, including real-component
  multilingual operation routing, free input and the existing MCP/Qt bindings.
- Rebuilt embedded SDK in Chrome: English/Chinese operation E2E plus the prior
  table-selection E2E, three cases passed. Each language exercised ten submitted
  actions, twelve resolver calls and three canceled late resolutions.
- Rebuilt native Qt SDK tests against the fresh package: ten checks passed,
  including reentrant resolver replacement and destruction during cancellation.
- Full `build:sdk`, generated public declarations, docs type check,
  changed-file ESLint, formatting and whitespace checks passed.
- Code, TypeScript and C++ reviews completed. Native review findings were
  reproduced as regressions and fixed before final validation.

Cancellation uses the platform [`AbortSignal` contract](https://dom.spec.whatwg.org/#interface-abortsignal).
The native bridge retains the existing [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
request/notification/response envelopes; it adds no model handshake or alternate
MCP transport.

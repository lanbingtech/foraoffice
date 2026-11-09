# Neutral Docs SDK implementation evidence

Spec: [#38](https://github.com/lanbingtech/foraoffice/issues/38).
Implementation baseline: `688166599064e953debe5f3ff9ecc3fc79be27ea`.
The user approved ticket publication and then explicitly authorized implementation and a local commit on the current branch.

## Delivered scope

| Ticket                                                     | Public behavior                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [#39](https://github.com/lanbingtech/foraoffice/issues/39) | Per-service Qt overrides, explicit disabling, authoritative cancellation/failure, and refusal of omitted managed lifecycle callbacks     |
| [#40](https://github.com/lanbingtech/foraoffice/issues/40) | Native search/replacement, repeated-match navigation, optional focus and stale reference rejection                                       |
| [#41](https://github.com/lanbingtech/foraoffice/issues/41) | Independent document-local range decorations, including read-only display, without authored output changes                               |
| [#42](https://github.com/lanbingtech/foraoffice/issues/42) | Pathless host-owned documents, explicit save-as adoption/export, host auto-save/read-only policy and existing save concurrency semantics |
| [#43](https://github.com/lanbingtech/foraoffice/issues/43) | Authorized local image paths and host asset references through the existing live insertion pipeline                                      |
| [#44](https://github.com/lanbingtech/foraoffice/issues/44) | Host-supplied advisory checkers/rules, refreshed diagnostic ranges, stale async result rejection and observable extension errors         |

Browser hosts use the public mounted handle. Qt hosts use the same public operations through `callSdk`, with lifecycle/checker callbacks supplied through generic service handlers. No business grammar or field catalog was added to the SDK core.

## Verification

- Environment: Windows, Qt 6.11.1 with the installed MSVC toolchain, Node 24.1.0, and installed Chrome for the browser fixture.
- Docs full suite: 519 files, 6037 cases; first run had 6016 passing, 16 skipped and 5 timeouts. The PowerShell npm shim consumed the requested worker option, so this run used default concurrency. Rechecking all four affected files by invoking Vitest directly with two workers passed all 89 cases without changing timeouts or assertions. These results are recorded separately rather than describing the original run as entirely green.
- After review fixes, affected SDK/bridge tests passed (8 files, 31 cases); dirty-state and lifecycle follow-up tests passed (5 files, 50 cases).
- Real native Qt SDK and browser-host integration both passed. They exercise hosted storage without paths, native expression replacement/navigation, read-only display, advisory checks, local image authorization and embedding, save/reopen, explicit save-as decisions, disposal/remount isolation and completion of pending native calls during normal close.
- PDFium renders of annotated versus clean Qt print output are identical. The persisted DOCX contains the expected original image bytes and no SDK decoration markup.
- The remaining four native CTest entries passed: independent backend startup, nonblocking disposal, backend lifecycle and service overrides. The public SDK CTest executable is also run by the output-verifying integration test.
- SDK assets, services and standalone declarations build successfully; Qt sources compile. Docs typechecking, changed-file ESLint, formatting, whitespace and semantic theme-color checks pass.
- Local detailed logs are under `D:/temp/foraoffice-sdk-*`; reproducible tests are committed with the implementation.

During real close testing, loading a read-only document exposed a false dirty transition: Tiptap's `setEditable` emits a content update by default. The view permission effect now disables that emission, preserving the authored dirty calculation. Tests verify clean read-only documents remain clean.

## Standards

Independent TypeScript and C++ review found three material issues: cached lifecycle endpoints outliving their host, native SDK completions abandoned by normal close, and asynchronous native-test callbacks retaining destroyed stack event loops. All were corrected and narrowly re-reviewed. Owner/host checks now also protect continuations after parsing, font loads and persistence; queued password cleanup retains its original services.

The final managed-service fallback guard and the view-only read-only correction were also reviewed. No remaining findings were reported within the reviewed changes.

## Spec

The specification review found one material gap: missing `adopt` on a committed save-as response could implicitly clear the active object's dirty state. Save As now requires an explicit decision, and adopting requires an identified target. The native integration test covers the malformed response and rejects old references after adoption of a different hosted object.

No further scope gaps or business customization were reported. Final review totals: Standards 3 findings resolved; Spec 1 finding resolved.

## Acceptance boundary

This verifies the neutral Docs SDK in local browser and real Qt hosts. It does not declare downstream DIGspace business integration, its performance acceptance, or other editors complete. External platform test environments were not modified. The built SDK is a development working-tree build, with its provenance accurately marked as dirty; this is not a clean release declaration.

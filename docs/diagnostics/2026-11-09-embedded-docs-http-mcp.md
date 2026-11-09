# Embedded Docs HTTP MCP implementation record

## Contract and implementation

Scope: [embedded Docs HTTP MCP specification](../specs/2026-11-09-embedded-docs-http-mcp.md), explicitly authorized through `implement` on 2026-11-09. Baseline: `03eb6119e0d1855e8114285fb1fbc3948a6ff03b`.

- `DocsQtEditor::startMcp`, `mcpState`, and `stopMcp` return JSON-RPC outcomes through native completions. `mcpStateChanged` carries status/document identity without credentials.
- A successful start returns standard Streamable HTTP connection information (URL, headers, transport, document generation, supported revisions). It neither requires an action handler nor triggers an AI action, model request, or external client configuration change.
- The owned Node backend binds an editor scope before opening its listener. Its HTTP service reuses `createDocsMcpServer` and the existing live runtime. Each protocol session gets an independent caller; the host owns the complete document grant.
- Explicit stop, generation replacement, close checks, disposal and backend/renderer failure revoke access. Pending enable cannot publish a grant after stop. Old revocations are matched by binding identity and cannot stop a newly enabled grant.
- The service remains loopback-only, authenticates a host-issued Bearer credential, validates Host/Origin, bounds request bodies/session count, and uses the installed MCP SDK's supported HTTP revisions (`2025-03-26`, `2025-06-18`, `2025-11-25`). No `2026-07-28` or legacy SSE support is claimed.
- The generic SDK README and packaged `mcp-http-client.mjs` example document connection and lifecycle ownership. No host-product business logic or Agent orchestration was added.

## Verification

- TDD seams: SDK HTTP service and Qt public native/adapter APIs. The initial HTTP import and native API compilation failed before implementation; Qt binding dispatch and scope-release regressions likewise failed before their implementations.
- Focused HTTP/Qt adapter tests passed. HTTP coverage includes live unsaved reads/writes, authentication/origin refusal, independent clients, revocation before first connection, idempotent close, pending caller cancellation, reentrant cleanup, and repeated failed HTTP initialization negotiation.
- TypeScript typechecking passed after the final production-code changes. Changed-file ESLint passed; the new hook dependency warning was removed. Formatting, theme-color and text-layout boundary checks passed.
- Native Qt tests passed for GUI-independent startup, nonblocking disposal, backend lifecycle, service overrides, the prior public SDK workflows, and HTTP MCP. The MCP test uses a real managed Qt editor with no action handler, the packaged official-client example, raw HTTP calls, read-only refusal, connected/unconnected replacement, explicit stop, an enable/stop race, and disposal after verifying the endpoint was usable.
- The complete Docs run used `node ../../node_modules/vitest/vitest.mjs run --maxWorkers=2`: 6026 passed, 16 skipped, one failure across 520 files (810.19 seconds). The failure was `docs-runtime-dependencies.test.ts` / `keeps embedded.tsx independent of native Agent inference and panels`: esbuild reported `The service was stopped`, rather than a failed dependency assertion. Its direct two-case rerun passed, but a subsequent parallel focused run hit its existing 20-second timeout. Full log: `D:/temp/foraoffice-http-mcp-docs-tests.log`.
- The final distributable SDK build exited 0 and generated `apps/docs/out/sdk`, including HTTP service declarations, the native API, the generic example, and matching Qt source/test files. Log: `D:/temp/foraoffice-http-mcp-sdk-build-final.log`. Packaged-runtime and final focused rerun logs are `D:/temp/foraoffice-qt-build/mcp-test-results.txt` and `D:/temp/foraoffice-http-mcp-final-targeted.log`.
- After the dependency-audit correction, the final focused run passed all 11 cases in the HTTP service, Qt adapter and dependency-audit files (11.14 seconds). Native backend/HTTP MCP checks also passed against the final packaged SDK. The complete suite was not repeated after this focused correction.

## Review findings and corrections

Independent TypeScript, C++ and spec-axis reviews found two distinct issues:

1. A schema-valid initialization with invalid HTTP negotiation headers could retain an uninitialized transport and exhaust the 32-session limit. The corrected regression reproduced connection exhaustion before the fix. The service now closes newly created servers when no protocol session was initialized, including normal 406/415 returns. Both rejected header cases are covered.
2. The native disposal regression could pass with an empty connection if its final re-enable failed. It now asserts successful start and initializes the endpoint before destroying the widget.

No other concrete implementation defects or product-specific branches were reported. The TypeScript Standards and Spec axes identified the same transport defect; the C++ review identified the test defect.

The failed dependency-audit test unnecessarily encoded styles/fonts into a 388,931,939-byte output that it never inspected. A local paired measurement took 11,612 ms with those assets versus 491 ms with asset loaders set to `empty` (15,214,141 output bytes). Both builds contained the identical 668 JavaScript/TypeScript inputs. The test now omits those non-code assets while preserving its executable dependency graph, assertions and 20-second limit. This removes measured wasted work; the original subprocess exit cause was not independently established. Measurement script: `D:/temp/foraoffice-http-mcp-dependency-profile.mjs`.

The final test-only loader change was independently reviewed: executable import traversal and the original Agent/model dependency assertion remain intact; no findings.

## Verification environment notes

- The old local Qt build cache set one global `/MAP:.../docs-qt-host.map` for every executable, producing a parallel linker output collision. Only that temporary build-cache flag was adjusted; no product linker configuration changed.
- The backend CTest registration omitted the Qt DLL path used by its sibling tests and exited with `0xc0000135`. Its registration now includes the same Qt Test runtime path and its focused rerun passed.
- Windows PowerShell stderr redirection recorded ordinary Node warnings as `NativeCommandError`, even when the native exit code was 0. SDK packaging was rerun through `cmd` redirection with its actual exit code preserved.
- A reviewer additionally ran repository-wide ESLint: it failed with 978 errors and 17 warnings, largely in existing `.task` and skill scripts. Its output was truncated. Those visible diagnostics do not establish runtime defects in this change; changed-file lint is the applicable passing result.

## Acceptance boundary

All operations in this task were local. No external test environment, deployed client, shared infrastructure or downstream application configuration was changed.

The packaged standard client and real Qt editor establish SDK interoperability. An actual external Agent product has not been connected; its version, supported protocol revision, header configuration and live-document behavior still need real-target acceptance. Reference-client success is not reported as downstream end-to-end acceptance. The generated SDK is a working-tree development package, not a clean release.

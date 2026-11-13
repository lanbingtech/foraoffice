# Electron verification after Agent neutralization

**Goal:** Re-run post-neutralization repairs on real Electron, distinguishing
shared editor behavior from the native Qt adapter's implementation.

**Range:** `790247a6` through `91dda347`, 18 non-merge commits. Tests use isolated
local profiles and fixtures, with no external model or test-environment writes.

- [x] Inventory every post-baseline change and its executable acceptance case.
- [x] Rebuild the normal Docs renderer/preload and Electron shell.
- [x] Run the same SDK integration, AI-operation and table-selection assertions
      inside genuine Electron BrowserWindows, recording actual engine versions.
- [x] Exercise normal desktop chrome, production CSP/image embedding, native
      selection behavior and the table revision/read/rewrite/save chain via the
      production Electron IPC/MCP path.
- [x] Independently verify shared Node backend grants and resource revocation;
      label these as backend tests rather than simulated native Electron IPC.
- [x] Review added tests, record the per-fix evidence and limitations, commit
      task-owned source/tests/docs on the current branch, and inspect final status.

Qt QProcess/GUI threading and Qt-native HTTP-MCP controls remain adapter-specific;
their Electron equivalents use Electron's existing main/preload and shell MCP
implementation. No Qt branch is added to shared editor behavior for this work.

The Node backend exposed a real concurrent creation/release-all grant race.
Reproduced twice with the existing test, fixed revocation before asynchronous
shutdown, rebuilt the service/SDK, and passed backend integration plus grant
tests. A corrected PNG comparator also exposed annotation text-run fragmentation
in Electron printing; the shared plugin now suspends view decorations through
standard print lifecycle events, with unit and real-print regressions.
Detailed evidence: [Electron parity report](../../diagnostics/2026-11-13-electron-parity.md).

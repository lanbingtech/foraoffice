# Native Ribbon Extension SDK

**Goal:** Expose host-neutral native Docs ribbon contributions: custom tabs,
groups on built-in tabs, and quick-access buttons, including dropdown menus.

**Design:** The public `editor.ui.ribbon` accepts validated JSON snapshots and
emits action IDs with captured document context. Contributions append to native
UI without replacing built-ins. They use the existing document-session token
contract and are cleared on document replacement. There is no host-specific
business vocabulary, executable UI, DOM injection, or alternate document path.
Browser/Electron use the public handle; Qt uses existing JSON-RPC SDK calls and
a dedicated ribbon-action signal. Native theme, density, menu keyboard/focus,
and selection preservation apply to contributed controls.

**Scope:** Docs, which currently provides the embedded editor SDK. Other editor
integrations are not claimed by this implementation. The user approved this
design in conversation and required neutrality.

- [x] Add failing tests for configuration validation, all three locations,
      stale configurations/actions, ancestor availability, reset and disposal.
- [x] Implement the declarative contract and document-scoped controller.
- [x] Render custom tabs, appended groups and quick-access controls using native
      button styles and a reusable menu renderer; verify keyboard and focus behavior.
- [x] Expose the public handle and Qt calls/events; add transport and real host
      integration coverage.
- [x] Document the generic contract and examples; build the distributable SDK,
      run targeted tests/typecheck/theme checks and request code review.

**Verification:** Controller/view/transport tests, existing file-menu regression
tests, browser SDK integration, native Qt public SDK integration where the local
toolchain is available, and generated public declarations. External environments
are outside the authorized write scope.

**Review and regressions:** TypeScript/UI and C++ reviews completed. Corrected
configuration updates closing unrelated native menus. Real Chromium regressions
cover RTL/LTR submenu placement and scrolling long root/nested menus; positioning
is owned by the shared native menu renderer, including the existing File menu.

**Completed validation:** 58 targeted controller/view/transport/native-ribbon/
startup/host regression tests; real browser SDK integration (light/dark/compact)
and real Chromium menu geometry; real Qt public SDK suite against the final
package; Docs typecheck, focused ESLint and theme checks. The final SDK builds
successfully, its generated declarations compile for an external consumer, and
its renderer CSS and Qt headers match the generated build/source respectively.

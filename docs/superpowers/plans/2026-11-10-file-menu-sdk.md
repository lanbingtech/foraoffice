# File menu SDK implementation plan

**Goal:** Expose document-scoped, declarative file menus through the browser and Qt SDKs without introducing host business operations into the editor.

**Architecture:** A small menu controller validates JSON menu trees, dispatches existing file commands, and emits opaque host action IDs. Document state subscriptions carry a session token; replacement, Save As adoption and disposal invalidate old menu configurations. The existing Ribbon position, persistence implementation and Qt transport remain responsible for rendering, saving and native communication.

**Tech stack:** TypeScript, React, Zod, Vitest, Qt 6/QWebChannel, Playwright.

## Tasks

- [x] Test and implement `renderer/sdk/file-menu.ts`: stable IDs, recursive groups/submenus, atomic updates, command policy, document session tokens, subscriptions and disposal.
- [x] Add document state/subscribe and `ui.fileMenu` to the public handle; wire existing App file actions and a separate menu view store without document transactions.
- [x] Test and render accessible menus in `components/FileMenu.tsx`; retain defaults and location; show the internal entry for embedded macOS hosts.
- [x] Extend `sdk/calls.ts`, `host/qt.ts`, Qt public signals and bootstrap to use the same contract; test actual bridge calls and teardown.
- [x] Add a compilable Qt integration example and SDK documentation, including all nine requested operations and cancellation/session semantics.
- [x] Build SDK declarations/assets and native Qt targets; run focused unit tests and real Qt/browser integration checks, including unchanged content, dirty state and existing save/export behavior.
- [x] Review TypeScript and C++ changes, resolve findings, run remaining affected checks, and commit on the current branch.

## Contract decisions

- A supplied menu is a complete snapshot; omission/reset uses existing defaults. Empty menus are allowed.
- Commands are a closed set: new/open/save/saveAs/exportPdf/exportHtml/exportMarkdown/exportImages. Custom actions are strings handled exclusively by the host.
- `set({documentToken, items})` requires the current token (`null` before a document exists). Item IDs are unique across the tree. Labels are plain text.
- Document subscriptions immediately report current state. Editor-level action subscriptions survive document switches; old document trees and tokens do not. Disposal clears all subscriptions.
- Menu visibility/enabled state does not grant command authority or alter shortcuts/automatic saving.
- Use existing QWebChannel JSON-RPC calls and notifications, with validation at the shared SDK boundary. Follow WAI-ARIA menu-button and submenu keyboard/focus behavior.

## Verification evidence

- Windows, Node 24.1.0, Qt 6.11.1/MSVC: SDK declarations and assets built; Qt widget, native tests and `docs-qt-file-menu-example` compiled.
- Focused Vitest run: 11 files, 45 tests passed. Covers public menu/controller, rendering, Qt bridge, hosted documents, disposal, default menus and existing save queue behavior.
- `e2e/docs-sdk-integration.spec.ts`: both real Qt and Chrome browser tests passed against the final built assets. Menu clicks reached existing managed save/save-as/export services; custom actions retained IDs/context; stale tokens were rejected. Browser checks include unchanged editor DOM identity, document revision/text/dirty state, working autosave and shortcuts with a hidden Save menu item, and correct permission subscriptions on reopen.
- Existing DOCX resource and rendered print-output comparisons passed in the real Qt integration test.
- Other native CTest entries: startup, nonblocking disposal, backend lifecycle, service overrides and HTTP MCP all passed. The public SDK executable was exercised by the output-verifying E2E test above.
- Docs typecheck, changed-file ESLint, Prettier, whitespace and semantic theme-color checks passed.
- Review findings corrected and narrowly re-reviewed: focus after removing a menu item/submenu, safe DOM IDs for arbitrary business IDs, and permission snapshots before Tiptap's passive editable update. The permission regression first failed against old assets with an incorrect read-only notification, then passed with the fix.
- SDK output is `apps/docs/out/sdk`, accurately marked as a dirty development build. This verifies local Docs browser/Qt integration, not downstream business acceptance or other suite editors. No external platform environment was modified.

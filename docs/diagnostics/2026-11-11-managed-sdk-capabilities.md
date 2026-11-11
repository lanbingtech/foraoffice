# Managed Docs SDK capability audit

## Reproduced defect and correction

The native AutoSave checkbox in `App.tsx` was disabled whenever
`getDocsDocumentHost()` returned a host. Its checked state came directly from
`host.autoSave.enabled`, and the timer and close guard also independently read
that initial setting. A real browser SDK regression reproduced the disabled
checkbox even with a writable document and a working `saveDocument` handler.

`auto-save.ts` now owns one effective state for the checkbox, timer/blur saves
and close checks. Managed `enabled` initializes that editor's switch; users may
toggle it unless the host explicitly sets `allowToggle: false`. Saving denial,
missing save support and hosted read-only state still disable automatic saving.
Managed preferences remain editor-local and do not change host configuration or
standalone storage. Existing hosts using `enabled: false` as a prohibition must
also supply `allowToggle: false`.

## Other mode and capability gates checked

| Surface                                                                     | Responsible gate                                                         | Finding                                                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body editing, formatting, tables, pictures                                  | `editor.isEditable`, document protection and selection state             | No blanket managed/embedded-mode disable found. Hosted read-only is an explicit restriction.                                                                           |
| Comments, revisions, notes, headers/footers, page setup, styles, watermarks | Native Ribbon state and `runtime/capabilities.ts`                        | Depend on document state and installed runtime accessors, not the presence of a managed host.                                                                          |
| Search, navigation and view annotations                                     | Public inspection/annotation implementations                             | Work in managed/read-only documents; existing browser and native Qt integrations cover them.                                                                           |
| New/open/save/save-as/export/create                                         | `DocsDocumentHost.capabilities`, lifecycle callbacks and export services | Explicit policy and service availability remain authoritative; cancellations and missing callbacks do not fall back to local storage.                                  |
| Local recovery and standalone startup/AI content consumption                | `withDocumentServices`, `writeRecoveryCopy`, App startup                 | Deliberate storage isolation. Hosted objects must not be written into local recovery/default folders.                                                                  |
| Native Agent/provider configuration and calls                               | `editorServices`, external Harness adapter                               | Deliberately separated from the neutral editor. External actions use the Harness; native editing tools remain available.                                               |
| Print/export                                                                | Native print/export services; Qt `supportsPrintScale`                    | Require the appropriate host service. Qt's driver-specific scale restriction does not disable printing.                                                                |
| New/switch window or tab                                                    | `openNewTab`, `listDocsTabs`, `focusDocsTab`                             | Window ownership belongs to the host. Services are exposed; the default Qt wrapper does not implement every shell window operation. Hosts may supply service handlers. |
| Zotero, OS spelling dictionaries and file encryption                        | Corresponding host/native services                                       | Service integration requirements, not blanket managed-mode disables. No claim that every external integration was exercised in this audit.                             |

Scope: the Docs SDK. The audit checked the source gates above; execution
verification focuses on automatic saving, hosted storage/read-only policy,
existing inspection/annotations and the shared browser/Qt public SDK paths.

Validation: 19 policy/host regression tests passed, including 11 AutoSave cases;
the real browser SDK verifies user toggles, blur saves, close state and read-only
gating. The final SDK's native Qt public suite passes with the new toggle checks.
Docs typecheck, focused ESLint, SDK build and external declaration consumption pass.

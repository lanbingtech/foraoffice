# Table revisions and AI cell selection

## Failure and ownership

AI whole-table replacement records the old table as a block deletion and the new
table as a block insertion. Both survive DOCX save/reload. The editor previously
rendered both as ordinary tables because `DocTable.renderHTML` ignored
`blockRevision`. Consequently the old table remained visible in final-content
views, and the inserted table remained visible in Original.

The AI selection pipeline independently treated any table selection as a whole
block. Its HTML serializer supplied no cell text selection markers, and
`replace_selection` refused paragraphs below depth 1. These were shared editor/SDK
limitations; the reproduction did not show a new-table selection being mapped to
the old table. Skipping a genuinely deleted block during AI reads remains the
intended behavior.

## Corrected contract

- Whole-table insertions/deletions use the existing revision classes and author
  attributes. The same CSS controls their markup, display modes and reviewer
  filters. Accept/reject removes the corresponding appearance.
- A text selection within one paragraph or list item in a table cell carries
  exact document positions, `<sel>` markers and `Selected text`, including a
  selection covering the entire paragraph inside a larger table.
- `replace_selection` replaces those live characters and inherits their formatting.
  Other cells, table geometry and text outside the selection remain intact.
  The frozen action selection survives focus movement.
- Block/row/cell deletion revisions cannot be rewritten. Existing inline deletion
  revisions remain untouched when a selection also covers live text. Reads and
  writes use the same live ranges, and reads preserve withheld-text placeholders.
- Selections crossing paragraphs or cells remain unsupported by
  `replace_selection`; the tool returns an explicit refusal.

The display behavior follows [Microsoft's tracked-change display modes](https://support.microsoft.com/en-gb/word/training/track-changes-in-word).
Position handling uses the installed ProseMirror model's `ResolvedPos.before()`
contract at the selection's actual paragraph depth.

## Verification

`apps/docs/tests/ai-table-selection.test.ts` covers SDK action binding, formatted
cell selections, ordinary and pending-insertion tables, tracking on/off, DOCX
save/reload, accept/reject, structural deletion guards, existing inline deletions,
cross-cell refusal and withheld-text positioning. It also covers cell positions
after mixed rowspan/orphan merge continuations, plain-text reads of ruby/formulas/
note numbers, and inheriting live text formatting rather than deleted-run
formatting. These tests reproduced the failures before the implementation changed.

`apps/docs/tests/table-block-revision-rendering.test.ts` covers real editor DOM
with production revision CSS, all four modes, reviewer/kind filters and
accept/reject cleanup. The previous test expecting table selections to lose
character precision now asserts the corrected behavior.

`e2e/docs-sdk-table-selection.spec.ts` mounts the freshly built embedded SDK in
Chrome, creates a real tracked whole-table replacement, checks display modes,
selects cell text through the browser DOM, binds that action, moves focus, replaces
the fragment and saves/reopens through the host's storage contract. It verifies
that AI reads contain only the polished current text and that neighboring content
and revision records remain intact.

Commands from the repository root:

```powershell
npm run test -w @genoffice/docs -- tests/ai-table-selection.test.ts tests/table-block-revision-rendering.test.ts
npm run typecheck -w @genoffice/docs
npm run build:embedded -w @genoffice/docs
node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts e2e/docs-sdk-table-selection.spec.ts --reporter=list --output=apps/docs/out/diagnostics/sdk-table-selection-e2e
```

Validation included 943 passing checks across 78 AI/runtime/revision/table test
files, followed by 104 passing checks across nine files covering the final
serialization and formatting corrections. Changed-file ESLint, type checking and
the embedded build passed. The real-browser SDK test passed against the rebuilt
bundle.

Browser tests use installed Chrome on Windows and Playwright Chromium elsewhere;
`FORAOFFICE_BROWSER_CHANNEL` can select another installed channel. All verification
is local; no external test environment is modified.

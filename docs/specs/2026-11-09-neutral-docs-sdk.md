# Neutral Docs SDK host integration

## Problem Statement

Embedding applications cannot consistently own document storage and lifecycle through the public Docs SDK. Native service replacement is incomplete, native find/replace is internal, custom diagnostics and view decorations are unavailable, and agent image insertion cannot resolve authorized local assets. These gaps must be closed without introducing application-specific document types, placeholder syntax, or alternate editing semantics.

## Solution

Expose the existing editor through a common browser and Qt SDK contract. Hosts optionally supply document storage, lifecycle policy, diagnostics, decoration rules and image sources. Standalone defaults remain available. Host cancellation, refusal and failure are final outcomes; they never trigger an unintended local operation.

## User Stories

1. As an embedding host, I want to override individual services so that I can reuse the remaining native defaults.
2. As a user, I want canceled host operations to stay canceled so that no local file is unexpectedly created.
3. As a host, I want disabled operations enforced at the command boundary so that shortcuts and tools cannot bypass policy.
4. As a host, I want to open a document identified by an opaque ID and bytes so that local paths are optional.
5. As a host, I want to decide the identity and display name of a new document so that business naming stays outside the editor.
6. As a host, I want first save and subsequent saves to commit through my storage so that a cache write cannot masquerade as a successful save.
7. As a host, I want save-as to explicitly adopt a copy or export without switching so that future saves target the intended object.
8. As a user, I want existing save concurrency, dirty, formatting and undo behavior preserved so that embedding does not change editing semantics.
9. As a host, I want to configure automatic saving and read-only access so that editing respects the current document policy.
10. As a user, I want menu, shortcut, start-page and tool actions to use the same lifecycle policy so that their behavior is consistent.
11. As a host, I want native literal, wildcard and regular-expression search so that results agree with the editor UI.
12. As a host, I want native replacement semantics and counts so that I can verify a requested edit.
13. As a host, I want to locate each repeated match independently so that a sidebar can navigate every occurrence.
14. As a host, I want stale document or revision references rejected so that a click cannot target unrelated text.
15. As a host, I want navigation without forced keyboard focus so that users can keep operating my sidebar.
16. As a reader, I want navigation and display annotations in a read-only document so that inspection needs no editing permission.
17. As an extension author, I want to inspect current document text and return range diagnostics so that my rules can report both valid and malformed constructs.
18. As a user, I want diagnostics refreshed after loading, typing, paste, undo, redo and agent edits so that displayed findings stay current.
19. As a user, I want diagnostics to remain advisory so that incomplete drafts can still be saved and exported.
20. As a host, I want to register, replace and remove independent decoration sets so that valid text can be highlighted without inventing document nodes.
21. As a user, I want decorated text to remain fully editable and copyable so that annotations do not change the authored content.
22. As a user, I want annotations excluded from document serialization, ordinary copying, printing and export so that only the editor view changes.
23. As a host, I want local image paths and opaque asset references resolved through authorized services so that the model need not transfer base64.
24. As a user, I want programmatic image insertion to use manual insertion's resource handling so that saved documents remain portable.
25. As a host, I want extensions and references isolated to the current document so that closing or switching cannot leak findings or decorations.
26. As a Qt host, I want public calls for search, navigation and extensions so that I do not need private renderer state or an Agent round trip.

## Implementation Decisions

- Provide optional host document lifecycle services and per-operation capabilities. An absent provider uses standalone behavior; a configured provider's refused, canceled or failed operation never falls back.
- Represent hosted documents with opaque identity, display name and content independently of local paths. The existing editor continues to create blank content and serialize DOCX.
- Preserve existing save serialization, in-flight edit detection, dirty transitions and undo rules. Integrate hosted persistence at the storage boundary rather than replacing the save algorithm.
- A save-as outcome explicitly chooses whether to adopt the returned object. Export never implicitly changes the active object's identity.
- Apply host policy before document actions, including tools and automatic operations. File-only CLI remains subject to its file authorization and cannot become an alternate managed-document save path.
- Expose native search and replacement through an editor inspection API using the same scanner and replacement operation as the UI. Preserve supported document scope and pattern semantics. Host-specific field filling escapes values according to those existing semantics.
- References contain document identity and content revision. Navigation and replacement validate them; stale references are explicitly refused. Navigation supports optional focus and works read-only.
- Provide a public, document-local checking extension contract usable by browser and Qt hosts. The specific rule execution mechanism is an implementation decision; it must support the host's complete grammar checks rather than only matching well-formed inputs. Business grammars and field catalogs remain supplied by the host or its extension. Cross-process JavaScript callbacks are not required.
- Keep diagnostic results advisory and separate from independently registered decorations. Map or recompute ranges after document transactions; discard stale asynchronous results.
- Render range decorations through view-only editor facilities, with bounded styles for background, text color and underline plus plain-text hints. Display annotations in both editable and read-only editor views; exclude them from print/export and serialization.
- Resolve image paths or host asset references through a dedicated source-reading service, reuse existing media limits, validate actual image content, and reuse the existing insertion pipeline. File authorization remains owned by the host configuration.
- Expose the common API through the public browser handle and Qt bridge. Reuse the current transport; no application-specific protocol or model handshake is introduced.
- Preserve the existing Qt worker lifecycle implementation.

## Testing Decisions

- Test externally observable behavior at public SDK and native Qt boundaries, supported by existing editor, host bridge, file-service and runtime test fixtures.
- Exercise hosted documents with no local path: new/open, cancellation/failure, save, save-as adoption versus export, read-only refusal and policy enforcement. Retain existing save-race and dirty regression tests unchanged.
- Compare public search/replace results with the existing native engine, including mixed formatting, repeated text, native replacement expressions, one-transaction undo, stale results and read-only navigation.
- Verify checkers and decorations after typing, paste-equivalent transactions, undo/redo, tool writes and document switches. Verify no changes to document JSON, copied text, dirty signals or history when only annotations change.
- Render annotations on read-only documents. Compare annotated and unannotated print/export output and verify display styles do not leak into either output.
- Verify authorized versus refused local image reads, revoked grants, supported byte content and host asset resolution; verify insertion modifies the live editor and survives DOCX serialization.
- Build distributable SDK declarations and assets, compile the Qt adapter, and exercise the real packaged runtime where supported locally. Distinguish SDK test success from downstream business-application acceptance.

## Out of Scope

- DIGspace report/template objects, field catalogs, placeholder syntax, sidebar grouping, business labels and publishing workflows.
- Changes to existing search scope, matching/replacement semantics, save concurrency rules, or document formatting inheritance.
- New spreadsheet, slide, PDF or Markdown SDK implementations.
- Changes to external test environments, deployment or shared infrastructure.
- Declaring downstream host performance or business integration complete from SDK tests alone.

## Further Notes

This specification covers original integration items 1, 2, 3, 4, 5 and 7. Item 6 already has a separate worker-thread implementation. The user confirmed the six boundaries and clarified that view annotations also apply to read-only documents displayed in the editor.

Related existing delivery tickets: #11 (Qt embedding) and #13 (complete Docs delivery), under the broader runtime spec #1. This specification describes additional neutral SDK acceptance gaps; it does not close, replace or declare those delivery tickets complete.

The user approved the six-ticket breakdown, then explicitly authorized implementation with the `implement` skill after publication. The six children are #39 (service overrides), #40 (native inspection), #41 (decorations), #42 (hosted lifecycle), #43 (image sources) and #44 (diagnostics). Their blocking relationships are recorded on GitHub. The `ready-for-agent` label describes readiness; implementation authority comes from that subsequent explicit instruction.

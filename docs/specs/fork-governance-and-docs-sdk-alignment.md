# ForaOffice fork governance and Docs SDK documentation alignment

## Problem Statement

ForaOffice is a fork of GenOffice that retains Apache-2.0 licensing for its
open-source work. Its direction is to separate editors from GenOffice's built-in
agent and desktop host so other applications and agents can integrate them.
Only Docs has undergone this separation so far.

The repository still largely presents itself as the upstream GenOffice desktop
suite. Its public documentation, contribution workflow, ownership, support links,
licensing explanations and distribution instructions do not consistently describe
this fork. Integrators cannot reliably distinguish existing Docs SDK capabilities
from inherited desktop features or future goals. Contributors may follow an
upstream-only workflow or contact upstream maintainers about fork-specific issues.

There is already substantial Docs SDK documentation and packaging support. The
problem is inconsistency across the repository, rather than an absence of all
documentation. Preserve and connect that work instead of recreating it.

## Solution

Align the repository's public identity, governance, documentation and delivery
checks with ForaOffice's actual direction and current implementation. Follow
GenOffice's lightweight governance style: a clear project entry point, focused
contributor guidance, explicit licensing and security boundaries, and automated
checks for claims that can be verified mechanically.

A reader must be able to establish the project's origin, license, maintenance
responsibility, current editor support, integration requirements and release
status without consulting local-only agent instructions or upstream marketing.
An integrator must be able to build the Docs SDK, install it outside the monorepo
and follow documented public interfaces in a supported host.

The work updates documentation and the metadata, templates, packaging definitions
and CI prerequisites needed to make that documentation true. It does not implement
host or agent separation for additional editors.

## User Stories

1. As a repository visitor, I want ForaOffice's name and purpose to be clear, so that I understand which project I am evaluating.
2. As a repository visitor, I want the GenOffice origin and source baseline to be acknowledged, so that I can distinguish upstream work from fork changes.
3. As an integrator, I want the separation of editor, host and agent responsibilities explained, so that I know which capabilities my application must supply.
4. As an integrator, I want a current editor support matrix, so that I do not assume every inherited editor already has a portable SDK.
5. As an integrator, I want project goals separated from implemented and verified capabilities, so that I can plan an integration against evidence.
6. As an integrator, I want a direct route from the project introduction to the existing Docs SDK guide, so that I can start without searching the source tree.
7. As an integrator, I want build and package installation instructions that work outside the monorepo, so that I can consume the delivered SDK independently.
8. As a host developer, I want service requirements and optional capabilities documented, so that I can implement storage, dialogs, assets, fonts, clipboard and printing correctly.
9. As a host developer, I want mounting, readiness, document replacement and disposal rules documented, so that my application manages editor lifetime correctly.
10. As a host developer, I want browser, Electron and Qt requirements and limitations stated, so that I can select a supported environment.
11. As a Qt integrator, I want native runtime deployment and host-supplied conversion requirements stated, so that I do not mistake the sample for the full desktop application's feature set.
12. As a host developer, I want hosted document identity, storage and save outcomes explained, so that I can connect remote or application-managed documents without inventing local paths.
13. As an agent developer, I want direct runtime calls, Harness callbacks and MCP entry points distinguished, so that I can choose the appropriate integration.
14. As an agent developer, I want the host to own model selection and conversation orchestration, so that using the editor does not require GenOffice's built-in agent or provider configuration.
15. As an agent developer, I want stable built-in operation identifiers and instruction hooks documented, so that I can handle actions independently of translated UI text.
16. As an agent developer, I want live editor operations distinguished from file-level CLI operations, so that I do not overwrite or miss unsaved editor changes.
17. As an agent developer, I want document and selection authority, freshness checks and revocation explained, so that actions cannot silently move to a replacement document.
18. As an MCP client integrator, I want supported transports, protocol revisions and credential handling described, so that I can configure a standard client safely and interoperably.
19. As a security reviewer, I want the editor, host, file service and external agent trust boundaries described, so that I can assess the integration's actual authority.
20. As a document owner, I want data processing and network responsibilities explained for each component, so that I understand where my document content may be sent.
21. As a document owner, I want privacy statements to reflect the actual distribution and host configuration, so that I am not given an unsupported promise of entirely local processing.
22. As a downstream distributor, I want applicable licenses, upstream attribution and modification notices retained, so that I can redistribute the project with its required notices.
23. As a downstream distributor, I want the inherited enterprise-license placeholder resolved explicitly, so that I understand the fork's Apache-2.0 policy and distribution boundary.
24. As a contributor, I want the actual fork development and review workflow documented, so that I do not follow the upstream private-tree snapshot process by mistake.
25. As a contributor, I want contribution licensing and review responsibilities stated, so that I know the terms and owners of my contribution.
26. As a contributor, I want issue and PR templates to collect SDK and host details, so that maintainers can reproduce integration problems.
27. As a vulnerability reporter, I want a working private channel maintained by this project, so that a fork-specific report reaches the responsible maintainers.
28. As a community participant, I want conduct reports to reach this project's responsible contacts, so that enforcement does not depend on upstream maintainers.
29. As a maintainer, I want public contribution guidance available in a clean clone, so that contributors do not depend on ignored local agent configuration.
30. As a non-English reader, I want translated entry points to state their currency and scope, so that an old translation does not misrepresent the fork.
31. As a prospective user, I want screenshots, demonstrations and badges to identify the product and capability they represent, so that upstream marketing is not mistaken for a verified fork deliverable.
32. As a desktop user, I want help content to distinguish inherited desktop behavior from embedded SDK behavior, so that I follow instructions applicable to my application.
33. As a package consumer, I want product metadata and support links to identify the fork, so that I can find its source and report issues correctly.
34. As a distributor, I want upstream-binary packaging recipes clearly identified, so that I do not assume they contain ForaOffice's source changes.
35. As a package consumer, I want SDK versioning and compatibility changes documented, so that I can decide when and how to upgrade.
36. As a maintainer, I want CI to build the SDK artifacts required by its integration tests, so that checks exercise the deliverable from a clean checkout.
37. As a maintainer, I want browser, Electron, Qt and real MCP interoperability evidence to state exactly what ran, so that skipped or reference-only tests are not presented as full acceptance.
38. As a release reviewer, I want package contents, provenance and verification results recorded, so that a release claim can be traced to the tested source and supported targets.

## Implementation Decisions

1. **Project identity and scope.** Use ForaOffice as the fork's public identity,
   acknowledge GenOffice and its copyright owners, and state that Docs is the
   only editor with the current host and external-agent separation work. Other
   editors remain inherited implementations until separately delivered. An
   inherited editor's presence does not establish an embedded SDK commitment.
2. **Evidence-based capability claims.** Describe portable integration as an
   adapter-based capability with explicit requirements. Treat arbitrary-host and
   arbitrary-agent support as the direction, not proof that every environment
   works. Distinguish implemented, verified, experimental and unsupported cases.
   Preserve the existing development-SDK qualification until milestone acceptance
   is supported by actual evidence.
3. **Documentation ownership.** Keep the project introduction concise and route
   integrators to the existing SDK guide. Maintain one authoritative description
   of each public contract; other documents link to it. Add focused architecture,
   compatibility or release guidance only where the existing guide does not
   serve the reader. Use English for contributor-facing source documentation and
   preserve the repository's established locale organization.
4. **Public integration contract.** Document the current editor handle, host
   services, hosted-document lifecycle, runtime callers, captured scopes, optional
   resources, inspection, view annotations, ribbon and file-menu extension points.
   Clarify required versus optional services, readiness, cancellation, disposal,
   single-editor-per-renderer constraints and document replacement. Do not invent
   a new API or protocol to explain the existing implementation.
5. **Host and agent boundaries.** The editor owns editing, document context,
   selection and review behavior. The host owns application services, storage,
   permissions and native integration. The external agent owns models,
   conversations and task orchestration. Describe built-in action descriptors and
   instruction resolution as optional integration hooks. Keep the native desktop
   agent documented as a consumer rather than a universal SDK prerequisite.
6. **Distinct automation surfaces.** Document file-level CLI processing,
   inherited desktop automation and live embedded-runtime automation separately.
   State which surface observes unsaved content and which reads a file. Separate
   private host IPC from public MCP endpoints, and document supported transport
   revisions and limitations from the actual implementation. Do not copy one
   surface's URLs, credentials, session rules or tools into another's examples.
7. **Compatibility and feature parity.** Record host engine requirements, Node and
   Qt requirements, native deployment dependencies and the supported document
   formats for each integration. State which conversions, exports, printing,
   fonts and resource capabilities require host implementation. Differentiate
   reusable components from demonstration hosts. Report tested operating systems,
   engine versions and host modes without extrapolating to untested targets.
8. **Apache-2.0 continuity.** Retain the Apache-2.0 license text and applicable
   upstream and dependency notices. Add accurate fork provenance and modification
   ownership without replacing upstream authorship. Audit modification notices in
   distributed changed files against the license requirements; a project change
   log alone is not assumed sufficient. Use an actual verified copyright owner
   rather than inferring a legal identity from a repository account.
9. **Enterprise boundary.** The fork does not adopt an enterprise licensing
   roadmap merely because the upstream repository reserved one. Retire the
   unused inherited enterprise placeholder from the fork's active product policy
   and release payloads, and update the corresponding licensing and ownership
   explanations. Preserve applicable attribution and provenance. Do not relicense
   upstream enterprise material or third-party dependencies as Apache-2.0. Any
   retained separately licensed material must remain explicitly identified and
   excluded from blanket Apache-2.0 claims.
10. **Branding and metadata.** Align public product names, descriptions, source
    links, issue links, acknowledgements, package metadata, icons and displayed
    branding with the fork. Preserve upstream references that explain origin or
    attribution. Do not mechanically rename internal workspace identifiers,
    existing CLI commands, compatibility environment variables or resource
    schemes; document deliberate compatibility names. Do not force the current
    development SDK to become a public registry package.
11. **Actual contribution workflow.** Replace the upstream private-tree mirror
    narrative with the fork's actual issue, branch, review, merge and release
    practices. Preserve focused changes, file fidelity, semantic theme tokens,
    locale completeness and relevant quality gates. Continue no-CLA,
    Apache-2.0 inbound-equals-outbound contribution terms. Identify actual
    maintainers for sensitive review ownership; do not reuse upstream owners.
12. **Community and security routing.** Route fork issues, private vulnerability
    reports and conduct complaints to verified fork-owned channels. Use an
    existing usable private channel, not a fabricated address or an assumed
    enabled GitHub feature. Keep the Contributor Covenant attribution. If a
    required channel needs account configuration, identify the precise remaining
    setup and do not claim that routing is operational before it is verified.
13. **Issue and PR evidence.** Collect editor or SDK surface, host kind, OS,
    engine/runtime versions, SDK source/version, automation mode and a minimal
    reproduction. Extend review prompts to cover public-contract documentation,
    host neutrality, permissions and format fidelity where applicable. Apply the
    existing triage vocabulary; avoid creating a parallel governance system.
14. **Security model.** Extend the current security policy to describe injected
    host-service authority, canonical file grants, private-state exclusion,
    document/selection scope, freshness checks, revocation, credential handling
    and bounded resource helpers. Explain save commitment and uncertain outcomes;
    cancellation does not promise rollback. Preserve still-applicable inherited
    threat models and clearly identify their affected components.
15. **Privacy model.** Separate editor processing, host-provided services, desktop
    telemetry/update configuration and external-agent data handling. State what
    context is handed to a host or agent and who determines subsequent storage
    and network transmission. Describe only verified defaults for each artifact.
    A fork without injected desktop analytics metadata is not automatically an
    analytics-enabled official upstream build. Document the actual limits of
    display or AI masking rather than treating it as a universal file-access
    restriction.
16. **Translations, help and demonstrations.** Update the project identity and
    scope in all maintained translated entry points. Fully translated content
    must match the authoritative version; translations awaiting substantive
    updates must carry a prominent status notice and a link to the authoritative
    version. Keep desktop help and CLI/agent-skill material accurate for their
    actual surfaces. Replace misleading primary product imagery with verified
    fork examples, or label retained imagery as upstream desktop demonstrations.
    Do not advertise nonexistent releases, signing, downloads or community sites.
17. **Packaging recipes and external services.** Identify recipes that download
    upstream binaries as upstream-only recipes that omit fork changes. Change
    them to fork artifacts only when such artifacts actually exist. Document
    build-injected update, analytics and font-download configuration and its
    absence behavior without adding service dependencies to the editor contract.
18. **Versioning and delivery.** Establish an SDK version and compatibility
    policy, with consumer-facing release notes for public API, service, tool and
    behavior changes. Reuse existing build provenance and license-copying
    machinery. Separate SDK delivery from desktop installer delivery and list
    each artifact's contents, host-supplied runtimes and support status. Preserve
    local installation as a supported distribution method.
19. **CI alignment.** Build embedded assets, Node services and the distributable
    SDK before tests that require them. Use a Node version suitable for SDK
    consumption in the SDK acceptance job without assuming all inherited jobs
    need the same change. Reuse existing browser and Electron host selection and
    existing Qt native test targets. Provide explicit supported-target coverage
    and package installation checks, with skipped and unavailable targets visible.
    Retain inherited fidelity and license checks relevant to shipped components.
20. **Public versus local guidance.** Publish contributor-facing SDK boundaries
    and update obligations in tracked project documentation. Keep intentionally
    ignored local agent configuration private; do not publish it wholesale or
    remove its ignore rules to satisfy a broken public pointer. Public documents
    must not require local-only files to be understood or followed.
21. **Execution order.** First align identity, licensing, ownership and reporting
    routes; then consolidate architecture, integration, security and privacy;
    finally synchronize translations, help, presentation and delivery checks.
    Reconcile overlapping content instead of generating duplicate manuals.

## Testing Decisions

1. **Agreed acceptance boundaries.** The user confirmed two main boundaries:
   the public repository as consumed from a clean clone, and the built SDK as
   consumed outside the monorepo. Prefer these existing high-level boundaries
   over new internal seams. Reuse browser, Electron, Qt and MCP tests. Do not add
   unit tests that merely mirror wording or reversible documentation edits.
2. **Public repository acceptance.** Review the introduction, maintained
   translations, governance, security/privacy policies, templates and distribution
   guidance together. Every public link must resolve to tracked content, an
   accurately identified upstream resource or a verified external project channel.
   Check project identity, support scope, contribution terms and maintenance
   responsibility for consistency. Historical attribution and intentional
   compatibility names are valid upstream references, not search-and-replace
   failures. Public instructions must work without ignored local configuration.
3. **Package acceptance.** Build from a clean source checkout, install the SDK
   into a separate consumer and load the documented entry points and TypeScript
   declarations. Confirm required assets, Node bundles, bundled dependencies,
   examples, Qt sources, applicable notices and build provenance are present.
   Confirm the consumer does not need private monorepo workspace resolution.
   Exercise the documented quickstart with an authorized sample document.
4. **Existing behavioral coverage.** Reuse the existing host-neutrality,
   startup, hosted-document, file-grant, runtime/MCP and embedded SDK integration
   coverage. Verify a supported host can mount, become ready, open a document,
   perform a public edit, observe unsaved changes, save and dispose. Preserve
   existing round-trip and untouched-content fidelity assertions. Reuse instruction
   hook and selection coverage when examples or contract descriptions change.
5. **Host and protocol coverage.** Run the existing browser and Electron SDK
   modes explicitly for their claimed support. Use existing Qt native tests on an
   appropriate runner for native claims. Verify standard MCP discovery and live
   document access with the actual target clients used in supported integrations;
   name the clients and versions in the evidence. A reference SDK client alone
   does not establish all-target interoperability. Do not treat skipped Qt tests
   or unavailable targets as passes.
6. **Security and privacy acceptance.** Trace policy claims to the existing
   permission, scope, stale-target, hosted-save and transport behavior and the
   existing relevant tests. Confirm replacement or disposal cannot retarget old
   authority, and inspect packaging configuration for claims about telemetry,
   updates and resource downloads. Use local fixtures and local services only;
   this spec grants no permission to write to external test environments.
7. **Repository checks.** Run the existing formatting, link/content review,
   locale coverage and license checks relevant to each changed artifact. Use
   existing lint, typechecking and behavioral suites when metadata, build or CI
   changes affect them. Do not interpret the existing help-language checker as
   proof that translated repository introductions are current. Add a mechanical
   guard only for a concrete gap that existing checks cannot cover.
8. **Completion evidence.** Record checked source revision, SDK version, artifact
   provenance, hosts/engines/client versions, commands run and explicit limitations.
   Account for every task-owned tracked and untracked file, commit tested and
   reviewed work and report working-tree status. Documentation is accepted only
   when its claims agree with the artifact and evidence; successful desktop
   compilation alone is insufficient SDK acceptance.

## Out of Scope

- Implementing host or external-agent separation for Sheets, Slides, PDF,
  Markdown or HTML.
- Replacing GenOffice's engines, rewriting working editor behavior or adding an
  agent framework, provider system, conversation UI or private transport protocol.
- Broad internal package renaming, speculative public APIs or unrelated refactors.
- Creating new enterprise modules, commercial licensing, a CLA, governance
  committees or an RFC approval process.
- Publishing public registry packages or inventing release artifacts merely to
  populate download links.
- Automatically enabling telemetry, updates, hosted infrastructure or remote MCP
  exposure.
- Modifying platform external test environments, deployments, containers,
  authentication, databases, connector/proxy settings, or shared infrastructure.
  Such writes, including cleanup and test-session creation, require separately
  approved actions under repository policy.
- Changing GitHub account settings or branch protection without the authorization
  needed for the specific action. Repository documents and configuration can be
  prepared and remaining account-side setup reported precisely.
- Implementing the revisions during the spec-writing task itself. A
  `ready-for-agent` label describes specification readiness and does not authorize
  starting implementation beyond the user's request.

## Further Notes

- This spec synthesizes the repository audit and user instructions dated
  2026-11-13. The audit checkout was at commit `c559fca7`; the Docs SDK records
  GenOffice baseline `v0.12.852`, commit
  `4b55db9ed1994575a695160ffc6cfd0bfc866211`. These are provenance references,
  not an instruction to reset or freeze future implementation to those revisions.
- The audit found that root governance and product documents remained unchanged
  from that baseline, while the Docs SDK already had substantial integration
  documentation and a builder that carries notices and source provenance. Preserve
  those existing investments.
- Local agent guidance is intentionally ignored. Its absence from a fresh clone
  is not itself a defect; relying on it for public contributor instructions is the
  defect this work must avoid.
- The license contract is the authoritative
  [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0), especially
  redistribution, contribution and trademark provisions. Preserve the provenance
  of separately licensed content rather than changing its license by assertion.
- Follow the lightweight governance presentation of
  [GenOffice](https://github.com/genspark-ai/genoffice), while documenting
  ForaOffice's actual workflow and responsibility. An upstream policy is not
  evidence that the same workflow or service exists in this fork.
- The project issue tracker is `lanbingtech/foraoffice`. Publish this spec with
  `ready-for-agent` and avoid duplicate umbrella issues. Subsequent execution may
  be divided along the delivery order above while retaining this scope and its
  acceptance criteria.

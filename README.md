# ForaOffice

<!-- Modified for ForaOffice from GenOffice project documentation. -->

Embeddable document editors with host-owned services and external-agent integration.
ForaOffice is a fork of [GenOffice](https://github.com/genspark-ai/genoffice),
licensed under [Apache-2.0](LICENSE). Its direction is to separate editors from
GenOffice's built-in agent and desktop shell so applications can supply their own
host and agents.

**Current scope: Docs.** The Docs SDK is a development package; its existence does
not mean the complete Docs milestone or every host/client combination is accepted.
Sheets, Slides, PDF, Markdown and HTML remain inherited desktop implementations.

[Docs SDK guide](apps/docs/sdk/README.md) ·
[Architecture and compatibility](docs/docs-sdk-integration.md) ·
[Versioning and delivery](docs/docs-sdk-releases.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)

<p>English · <a href="docs/i18n/README.es.md">Español</a> · <a href="docs/i18n/README.pt-BR.md">Português (Brasil)</a> · <a href="docs/i18n/README.de.md">Deutsch</a> · <a href="docs/i18n/README.fr.md">Français</a> · <a href="docs/i18n/README.zh-CN.md">简体中文</a> · <a href="docs/i18n/README.zh-TW.md">繁體中文</a> · <a href="docs/i18n/README.ko.md">한국어</a> · <a href="docs/i18n/README.ja.md">日本語</a> · <a href="docs/i18n/README.ar.md">العربية</a> · <a href="docs/i18n/README.ru.md">Русский</a> · <a href="docs/i18n/README.it.md">Italiano</a> · <a href="docs/i18n/README.nl.md">Nederlands</a> · <a href="docs/i18n/README.pl.md">Polski</a> · <a href="docs/i18n/README.cs.md">Čeština</a> · <a href="docs/i18n/README.id.md">Bahasa Indonesia</a> · <a href="docs/i18n/README.ms.md">Bahasa Melayu</a> · <a href="docs/i18n/README.th.md">ไทย</a> · <a href="docs/i18n/README.hi.md">हिन्दी</a> · <a href="docs/i18n/README.he.md">עברית</a> · <a href="docs/i18n/README.vi.md">Tiếng Việt</a> · <a href="docs/i18n/README.tr.md">Türkçe</a></p><!-- lang-switcher -->

## What is available

| Component                      | Current status                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Docs editor                    | Portable mount API with injected host services, live runtime, hosted documents, review and UI extension points                         |
| Browser / Electron integration | Public host adapters; application services and permissions are supplied by the embedding host                                          |
| Qt integration                 | Reusable widget and demonstration host sources; Qt 6.8+ and a deployed Qt runtime are required                                         |
| External agents                | Direct runtime calls, optional Harness action/instruction hooks and standard MCP adapters; no built-in model configuration is required |
| Other editors and shell        | Inherited desktop implementations; equivalent portable SDK work is not complete                                                        |
| Delivery                       | Local development SDK build and installation; supported/verified targets are recorded with each delivery's evidence                    |

The editor owns document editing, context and selection. The host owns storage,
permissions, native services and application UI. An external agent owns model
calls, conversations and orchestration. See the [integration overview](docs/docs-sdk-integration.md)
for required capabilities and limits. Supporting arbitrary hosts and agents is the
goal; an adapter interface is not a claim that every environment has been tested.

## Build the Docs SDK

Use Node 24+ and npm 10+:

```sh
npm ci
npm run build:sdk
npm run check:sdk-package
```

The generated package is `apps/docs/out/sdk`. Install that directory into another
project and follow the [SDK guide](apps/docs/sdk/README.md) for the public mount API,
file services, Qt host and MCP examples. The package includes editor assets and
Node services; the host supplies Electron/Qt/Chromium runtimes where needed.

The Qt sample opens `.docx`. Legacy Word, ODF, Hancom and HTML/MHT chunk display
conversion require host integration; the inherited Electron application has its
own converters. See [compatibility](docs/docs-sdk-integration.md#integration-targets)
for the current boundary.

## Automation surfaces

- **Embedded runtime and MCP:** operate on a mounted live document, including
  unsaved edits and captured authorized selections. Start with the SDK guide.
- **Office CLI and its MCP tools:** perform file-level work and do not observe a
  view's unsaved changes. The inherited `genoffice` command remains a compatibility
  name; see the [CLI reference](packages/cli/README.md).
- **Inherited desktop integrations:** belong to the desktop application and its
  settings. They are not prerequisites for embedding Docs.

Private host IPC is not a public MCP endpoint. The SDK guide defines the live
runtime's transport revisions, credentials, document bindings and revocation.

## Development

```sh
npm run fixtures       # generate engine test documents
npm run dev:docs       # standalone Electron Docs consumer
npm run dev            # inherited editors and shell
npm run format:check
npm run lint
npm run typecheck
npm test
```

The Sheets desktop component additionally requires Rust for its xlsx sidecar.
Use [CONTRIBUTING.md](CONTRIBUTING.md) for repository layout, SDK boundaries,
checks and review practices. Desktop installers are separate build products; build
commands do not promise published or signed ForaOffice releases. The inherited
[Linux wrapper recipes](packaging/README.md) identify when they download upstream
GenOffice binaries rather than this fork.

## Source, releases and community

The fork's source and issue tracker are
[lanbingtech/foraoffice](https://github.com/lanbingtech/foraoffice).
Report bugs and feature requests through this repository's issue templates.
For security or sensitive conduct reports, read the current private-channel
availability in [Security](SECURITY.md#reporting-a-vulnerability) and the
[Code of Conduct](CODE_OF_CONDUCT.md#enforcement) before submitting details.

The recorded Docs source baseline is GenOffice `v0.12.852`, commit
`4b55db9ed1994575a695160ffc6cfd0bfc866211`. Built SDKs record their actual source
revision and dirty status. [Delivery policy](docs/docs-sdk-releases.md) explains
versioning, compatibility notes and acceptance evidence. No upstream download,
release badge, screenshot, signing claim or community channel is presented here as
a ForaOffice deliverable. Inherited media under `docs/assets/readme` depicts the
upstream desktop suite and is retained as upstream reference material.

## Data and trust

The editor does not choose a model or an external storage service. Hosts and
agents determine which document context they receive and what they store or
transmit. The SDK cannot promise local-only processing for every embedding
application. See [Privacy](PRIVACY.md) for component responsibilities and optional
desktop telemetry, and [Security](SECURITY.md) for permissions and runtime authority.

## Acknowledgements and license

ForaOffice builds on GenOffice and the work of Mainfunc, Inc. and upstream
contributors. Core inherited dependencies include Electron, Tiptap/ProseMirror,
Univer, PDFium, pdf.js, pdf-lib, React, Konva, HarfBuzz, CodeMirror, JSZip and
fast-xml-parser, along with the font and conversion libraries identified in the
third-party notices. `npm run notices` regenerates the distribution's notices;
retain the licenses of the actual components you redistribute.

The open-source code is licensed under [Apache-2.0](LICENSE); dependencies and fonts
retain their own licenses. [NOTICE](NOTICE) preserves applicable upstream
attribution and describes the fork. The unused upstream enterprise placeholder is
not part of this fork's product policy or release payloads; its removal does not
relicense upstream enterprise material. GenOffice and Genspark names and logos
remain trademarks of Mainfunc, Inc.; references here describe project origin.

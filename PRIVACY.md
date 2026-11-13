# ForaOffice Privacy

<!-- Modified for ForaOffice from GenOffice privacy guidance. -->

Last updated: November 13, 2026

## Editor, host and agent responsibilities

The Docs SDK supplies document editing and runtime interfaces. It does not choose
a model, conversation service or application storage endpoint. An embedding host
owns the services it injects, including document storage, assets, font retrieval,
exports, printing, logging and any network access. The host may store documents
locally or use managed/remote storage; the editor cannot promise that every host
keeps files on one machine.

When an application forwards an editor action or connects an agent to the live
runtime, the authorized document/selection context and supplied instructions can
become available to that consumer. The host and external agent determine subsequent
model requests, logging, retention and transmission. Review their disclosures and
authorization policy. Adding a host or agent is not consent to an unspecified cloud
service operated by this project.

The provided Node file services process authorized files under configured grants.
File-level CLI operations read their specified files, not a view's unsaved state.
View annotations and AI masking do not remove the original content from a DOCX
file or prevent another authorized host, CLI or export path from reading it. See
[Security](SECURITY.md) and the [integration overview](docs/docs-sdk-integration.md).

The inherited standalone desktop application opens, edits, saves and converts
files locally, while its AI/provider/search features can make network requests.
Those desktop settings are not the SDK's external-agent contract.

## Optional desktop usage analytics

The inherited desktop analytics implementation becomes active only when a packaged build has injected GA4 measurement metadata. Source/fork builds without it use an inactive tracker. The Docs SDK does not inherit a desktop reporting setup simply by being embedded. A distributor enabling analytics must disclose its own collection and identify its recipient. When that desktop tracker is active, reporting defaults to enabled, including the initial launch before onboarding; onboarding explains collection and opt-out.

You can disable reporting at any time under **Settings → General → Send
anonymous usage statistics**. An explicit opt-out is remembered and stops all
subsequent analytics events.

### Events and parameters

When enabled, the app sends these events:

- `install_first_launch` — marks the first analytics-enabled use of a newly
  assigned anonymous `client_id`; used for retention cohorts
- `app_launch` — no event-specific parameter
- `file_open` — `ext`, the file extension such as `docx` or `xlsx`
- `file_new` — `kind`, one of `docx`, `xlsx`, `pptx`, `md`, or `pdf`
- `login_click` — no event-specific parameter
- `login_success` — no event-specific parameter

Every event includes:

- `app_version`
- `platform`
- `os_version`
- `ui_lang`
- a per-process `session_id` derived from the process start time
- `engagement_time_msec` with the fixed value `100`

When available, the payload also includes `country_id`, the two-letter country
code from the operating system's regional locale. This can differ from the
user's physical location.

The Google Analytics 4 payload also uses a random install UUID as `client_id`.
The country code is sent through GA4's country-only `user_location` field; the
app does not send a city or region. Neither identifier is a Genspark account or
email address.

## Network information

Events are sent to Google Analytics 4 using the Measurement Protocol over
HTTPS. As the HTTPS recipient, Google necessarily sees the connection's public
IP address and transport metadata, and may use them for coarse geolocation and
security or spam-abuse processing. The desktop tracker does not add an IP address to the
event payload.

## Data not collected by analytics

The inherited desktop analytics event schema does not send:

- document content
- file names
- file paths
- Genspark account identity
- email addresses

Analytics metadata is supplied at packaging time and is not a repository credential. Builds without it install a no-op tracker. This disclosure describes that tracker only; it does not establish the privacy behavior of a different host, agent, provider or distributor.

## Updates and downloadable fonts

The inherited desktop package can receive an update-feed URL and font CDN URL at
build time. Without the update URL, no feed is embedded and in-app automatic updates
remain disabled. Without the font URL, downloadable-font catalog entries/prompts
are hidden; local font installation remains available. Enabling these services can
create requests to the configured recipients and must be disclosed by the
embedding application or distributor. These are optional desktop facilities, not
requirements of the editor's host interface.

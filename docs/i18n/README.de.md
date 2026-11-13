<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice ist ein Fork von [GenOffice](https://github.com/genspark-ai/genoffice) und behält für seine Open-Source-Arbeit die Lizenz Apache-2.0 bei. Ziel ist, die Editoren von der ursprünglichen Host-Anwendung und dem eingebauten Agenten zu trennen, damit andere Anwendungen und Agenten sie integrieren können.

> Dies ist eine kurze übersetzte Einführung. Vollständige und aktuelle Informationen stehen in der [englischen README](../../README.md).

## Aktueller Umfang

Die bisherige Entkopplung betrifft nur Docs. Das Entwicklungs-SDK bietet Host-Schnittstellen, eine Laufzeit zur Bearbeitung geöffneter Dokumente und Beispiele für Browser, Electron und Qt. Die anderen Editoren sind übernommene Desktop-Implementierungen von GenOffice; ihre entsprechende Entkopplung ist nicht abgeschlossen. Vorhandene Schnittstellen belegen weder Unterstützung für jeden Host und Agenten noch die Abnahme eines fertigen Meilensteins.

## Integration und Beiträge

[Docs-SDK-Anleitung](../../apps/docs/sdk/README.md) · [Architektur und Kompatibilität](../docs-sdk-integration.md) · [Versionierung und Auslieferung](../docs-sdk-releases.md)

Der Host stellt Speicher, Berechtigungen und Systemdienste bereit. Der externe Agent verantwortet Modellwahl, Gespräche und Aufgabensteuerung. Dateibasierte Werkzeuge und die Laufzeit des geöffneten Editors sind unterschiedliche Schnittstellen. Desktop-Funktionen gehören nicht automatisch zum SDK.

[Beiträge](../../CONTRIBUTING.md) · [Sicherheit](../../SECURITY.md) · [Datenschutz](../../PRIVACY.md) · [Lizenz](../../LICENSE) · [Herkunftshinweise](../../NOTICE)

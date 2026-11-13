<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice jest forkiem [GenOffice](https://github.com/genspark-ai/genoffice) i zachowuje Apache-2.0 dla swoich prac open source. Celem jest oddzielenie edytorów od pierwotnej aplikacji hosta i wbudowanego agenta, aby mogły je integrować inne aplikacje i agenci.

> To jest skrócone, przetłumaczone wprowadzenie. Pełne i aktualne informacje zawiera [angielski README](../../README.md).

## Obecny zakres

Dotychczasowe prace nad oddzieleniem obejmują tylko Docs. Rozwojowy SDK udostępnia interfejsy hosta, środowisko edycji na żywo oraz przykłady dla przeglądarki, Electron i Qt. Pozostałe edytory to odziedziczone implementacje desktopowe GenOffice; ich analogiczne oddzielenie nie jest ukończone. Istnienie interfejsów nie oznacza obsługi każdego hosta i agenta ani akceptacji końcowego etapu.

## Integracja i współtworzenie

[Przewodnik Docs SDK](../../apps/docs/sdk/README.md) · [Architektura i zgodność](../docs-sdk-integration.md) · [Wersjonowanie i dystrybucja](../docs-sdk-releases.md)

Host zapewnia pamięć masową, uprawnienia i usługi systemowe; zewnętrzny agent zarządza modelem, rozmową i zadaniami. Narzędzia plikowe i środowisko otwartego edytora stanowią odrębne interfejsy. Funkcje desktopowe nie są automatycznie częścią SDK.

[Współtworzenie](../../CONTRIBUTING.md) · [Bezpieczeństwo](../../SECURITY.md) · [Prywatność](../../PRIVACY.md) · [Licencja](../../LICENSE) · [Informacje o autorstwie](../../NOTICE)

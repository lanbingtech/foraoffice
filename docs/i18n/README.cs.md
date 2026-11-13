<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice je fork projektu [GenOffice](https://github.com/genspark-ai/genoffice), který pro svou otevřenou část zachovává licenci Apache-2.0. Cílem je oddělit editory od původní hostitelské aplikace a vestavěného agenta, aby je mohly integrovat jiné aplikace a agenti.

> Toto je stručný přeložený úvod. Úplné a aktuální informace obsahuje [anglický README](../../README.md).

## Současný rozsah

Oddělení se zatím týká pouze editoru Docs. Vývojové SDK nabízí rozhraní hostitele, živý editační runtime a příklady pro prohlížeč, Electron a Qt. Ostatní editory jsou převzaté desktopové implementace GenOffice a stejné oddělení u nich není dokončeno. Samotná rozhraní nedokládají podporu všech hostitelů a agentů ani přijetí finálního milníku.

## Integrace a přispívání

[Průvodce Docs SDK](../../apps/docs/sdk/README.md) · [Architektura a kompatibilita](../docs-sdk-integration.md) · [Verzování a dodání](../docs-sdk-releases.md)

Hostitel poskytuje úložiště, oprávnění a systémové služby; externí agent řídí model, konverzaci a úlohy. Dokumentace rozlišuje nástroje pro soubory od živého editoru. Funkce desktopové aplikace nejsou automaticky součástí SDK.

[Přispívání](../../CONTRIBUTING.md) · [Bezpečnost](../../SECURITY.md) · [Soukromí](../../PRIVACY.md) · [Licence](../../LICENSE) · [Uvedení původu](../../NOTICE)

<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice is een fork van [GenOffice](https://github.com/genspark-ai/genoffice) en behoudt Apache-2.0 voor zijn opensourcewerk. Het doel is editors los te koppelen van de oorspronkelijke hostapplicatie en ingebouwde agent, zodat andere applicaties en agents ze kunnen integreren.

> Dit is een beknopte vertaalde introductie. De [Engelse README](../../README.md) bevat de volledige en actuele informatie.

## Huidige reikwijdte

Het ontkoppelingswerk betreft momenteel alleen Docs. De ontwikkel-SDK biedt hostinterfaces, een runtime voor live bewerking en voorbeelden voor browser, Electron en Qt. De overige editors zijn overgenomen desktopimplementaties van GenOffice; dezelfde ontkoppeling is daar niet voltooid. De interfaces bewijzen geen ondersteuning voor iedere host of agent en betekenen niet dat een eindmijlpaal is geaccepteerd.

## Integratie en bijdragen

[Docs-SDK-handleiding](../../apps/docs/sdk/README.md) · [Architectuur en compatibiliteit](../docs-sdk-integration.md) · [Versies en distributie](../docs-sdk-releases.md)

De host levert opslag, machtigingen en systeemdiensten; de externe agent beheert het model, gesprekken en taken. Bestandstools en de runtime van de geopende editor zijn verschillende interfaces. Desktopfuncties zijn niet automatisch onderdeel van de SDK.

[Bijdragen](../../CONTRIBUTING.md) · [Beveiliging](../../SECURITY.md) · [Privacy](../../PRIVACY.md) · [Licentie](../../LICENSE) · [Naamsvermelding](../../NOTICE)

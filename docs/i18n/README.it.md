<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice è un fork di [GenOffice](https://github.com/genspark-ai/genoffice) che mantiene Apache-2.0 per il proprio lavoro open source. L’obiettivo è separare gli editor dall’applicazione ospitante e dall’agente integrato originali, per consentirne l’integrazione in altre applicazioni e agenti.

> Questa è un’introduzione tradotta e sintetica. Le informazioni complete e aggiornate sono nel [README inglese](../../README.md).

## Ambito attuale

Il lavoro di separazione svolto riguarda solo Docs. L’SDK di sviluppo offre interfacce host, un runtime di modifica in tempo reale ed esempi per browser, Electron e Qt. Gli altri editor restano le implementazioni desktop ereditate da GenOffice; la loro separazione equivalente non è completata. La presenza delle interfacce non dimostra il supporto di qualsiasi host o agente né l’accettazione di una milestone finale.

## Integrazione e contributi

[Guida Docs SDK](../../apps/docs/sdk/README.md) · [Architettura e compatibilità](../docs-sdk-integration.md) · [Versioni e distribuzione](../docs-sdk-releases.md)

L’host fornisce archiviazione, autorizzazioni e servizi di sistema; l’agente esterno gestisce modello, conversazione e attività. Gli strumenti sui file e il runtime dell’editor aperto sono interfacce distinte. Le funzionalità desktop non sono automaticamente incluse nell’SDK.

[Contribuire](../../CONTRIBUTING.md) · [Sicurezza](../../SECURITY.md) · [Privacy](../../PRIVACY.md) · [Licenza](../../LICENSE) · [Attribuzioni](../../NOTICE)

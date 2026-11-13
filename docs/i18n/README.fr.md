<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice est un fork de [GenOffice](https://github.com/genspark-ai/genoffice) qui conserve Apache-2.0 pour son travail open source. Il vise à séparer les éditeurs de leur application hôte et de leur agent intégré d’origine pour permettre leur intégration dans d’autres applications et agents.

> Cette page est une introduction traduite et abrégée. Le [README anglais](../../README.md) contient les informations complètes et à jour.

## Périmètre actuel

La séparation effectuée concerne uniquement Docs. Le SDK de développement fournit des interfaces hôtes, un environnement d’édition en direct et des exemples pour navigateur, Electron et Qt. Les autres éditeurs restent les implémentations de bureau héritées de GenOffice ; leur séparation équivalente n’est pas terminée. Ces interfaces ne prouvent ni la prise en charge de tout hôte et agent ni la validation d’un jalon final.

## Intégration et contributions

[Guide Docs SDK](../../apps/docs/sdk/README.md) · [Architecture et compatibilité](../docs-sdk-integration.md) · [Versions et distribution](../docs-sdk-releases.md)

L’hôte fournit le stockage, les autorisations et les services système ; l’agent externe gère le modèle, la conversation et les tâches. Les outils agissant sur des fichiers et l’environnement de l’éditeur ouvert constituent des interfaces distinctes. Les fonctions de bureau ne sont pas automatiquement incluses dans le SDK.

[Contribuer](../../CONTRIBUTING.md) · [Sécurité](../../SECURITY.md) · [Confidentialité](../../PRIVACY.md) · [Licence](../../LICENSE) · [Attributions](../../NOTICE)

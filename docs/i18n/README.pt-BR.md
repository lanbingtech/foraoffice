<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice é um fork do [GenOffice](https://github.com/genspark-ai/genoffice) que mantém Apache-2.0 para seu trabalho de código aberto. Seu objetivo é separar os editores do aplicativo hospedeiro e do agente integrado originais, permitindo a integração com outros aplicativos e agentes.

> Esta é uma introdução traduzida e resumida. O [README em inglês](../../README.md) contém as informações completas e atualizadas.

## Escopo atual

O trabalho de separação realizado até agora abrange apenas Docs. O SDK de desenvolvimento oferece interfaces de hospedeiro, um ambiente de edição ao vivo e exemplos para navegador, Electron e Qt. Os demais editores continuam como implementações desktop herdadas do GenOffice; a mesma separação ainda não foi concluída. A existência das interfaces não comprova suporte a todos os hospedeiros ou agentes nem a aceitação de um marco final.

## Integração e contribuições

[Guia do Docs SDK](../../apps/docs/sdk/README.md) · [Arquitetura e compatibilidade](../docs-sdk-integration.md) · [Versões e distribuição](../docs-sdk-releases.md)

O hospedeiro fornece armazenamento, permissões e serviços do sistema; o agente externo gerencia modelo, conversa e tarefas. Ferramentas que operam sobre arquivos e o ambiente do editor aberto são interfaces distintas. Os recursos desktop não fazem parte do SDK automaticamente.

[Contribuir](../../CONTRIBUTING.md) · [Segurança](../../SECURITY.md) · [Privacidade](../../PRIVACY.md) · [Licença](../../LICENSE) · [Atribuições](../../NOTICE)

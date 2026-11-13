<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice es un fork de [GenOffice](https://github.com/genspark-ai/genoffice) que mantiene Apache-2.0 para su trabajo de código abierto. Su objetivo es separar los editores de la aplicación anfitriona y del agente integrado originales para que otras aplicaciones y agentes puedan integrarlos.

> Esta es una introducción traducida y resumida. Consulta el [README en inglés](../../README.md) para obtener la información completa y actualizada.

## Alcance actual

La separación realizada hasta ahora solo abarca Docs. El SDK de desarrollo ofrece interfaces para el anfitrión, un entorno de edición en vivo y ejemplos para navegador, Electron y Qt. Los demás editores conservan las implementaciones de escritorio heredadas de GenOffice y aún no han completado la misma separación. Estas interfaces no demuestran compatibilidad con todos los anfitriones o agentes ni la aceptación de un hito final.

## Integración y contribuciones

[Guía de Docs SDK](../../apps/docs/sdk/README.md) · [Arquitectura y compatibilidad](../docs-sdk-integration.md) · [Versiones y distribución](../docs-sdk-releases.md)

El anfitrión proporciona almacenamiento, permisos y servicios del sistema; el agente externo gestiona el modelo, la conversación y las tareas. Las herramientas que operan sobre archivos y el entorno del editor abierto son interfaces distintas. Las funciones de escritorio no se incluyen automáticamente en el SDK.

[Contribuir](../../CONTRIBUTING.md) · [Seguridad](../../SECURITY.md) · [Privacidad](../../PRIVACY.md) · [Licencia](../../LICENSE) · [Atribuciones](../../NOTICE)

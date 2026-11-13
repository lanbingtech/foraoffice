<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice 是 [GenOffice](https://github.com/genspark-ai/genoffice) 的 fork，继续对自身的开源工作采用 Apache-2.0。项目目标是将编辑器与原有宿主应用、内置智能体解耦，使其他应用和智能体能够接入。

> 本页是简要译介。完整说明和最新信息以[英文 README](../../README.md) 为准。

## 当前范围

目前只对 Docs 进行了这类解耦改造。开发版 SDK 提供宿主接口、实时编辑运行时，以及浏览器、Electron 和 Qt 示例。其他编辑器仍是继承自 GenOffice 的桌面实现，尚未完成同类解耦。接口已经存在，不代表已验证任意宿主或智能体，也不代表最终里程碑已验收。

## 接入与贡献

[Docs SDK 接入指南](../../apps/docs/sdk/README.md) · [架构与兼容范围](../docs-sdk-integration.md) · [版本与交付](../docs-sdk-releases.md)

宿主提供存储、权限和系统服务；外部智能体负责模型、会话和任务编排。文件级工具与操作当前打开文档的运行时是不同接口，桌面应用的功能也不自动成为 SDK 的能力。

[贡献指南](../../CONTRIBUTING.md) · [安全](../../SECURITY.md) · [隐私](../../PRIVACY.md) · [许可证](../../LICENSE) · [来源与署名](../../NOTICE)

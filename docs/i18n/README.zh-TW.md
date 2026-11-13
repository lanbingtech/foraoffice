<!-- Modified for ForaOffice: clarify the fork identity and integration scope. -->

# ForaOffice

ForaOffice 是 [GenOffice](https://github.com/genspark-ai/genoffice) 的 fork，持續對自身的開源工作採用 Apache-2.0。專案目標是將編輯器與原有宿主應用程式、內建智慧代理解耦，讓其他應用程式和代理能夠整合。

> 本頁是簡要譯介。完整說明與最新資訊以[英文 README](../../README.md) 為準。

## 目前範圍

目前只對 Docs 進行了這類解耦改造。開發版 SDK 提供宿主介面、即時編輯執行環境，以及瀏覽器、Electron 和 Qt 範例。其他編輯器仍是繼承自 GenOffice 的桌面實作，尚未完成同類解耦。介面已存在，不代表已驗證任何宿主或代理，也不代表最終里程碑已驗收。

## 整合與貢獻

[Docs SDK 整合指南](../../apps/docs/sdk/README.md) · [架構與相容範圍](../docs-sdk-integration.md) · [版本與交付](../docs-sdk-releases.md)

宿主提供儲存、權限和系統服務；外部代理負責模型、對話和任務協調。檔案層級工具與操作目前開啟文件的執行環境是不同介面，桌面應用程式的功能也不會自動成為 SDK 的能力。

[貢獻指南](../../CONTRIBUTING.md) · [安全](../../SECURITY.md) · [隱私](../../PRIVACY.md) · [授權條款](../../LICENSE) · [來源與署名](../../NOTICE)

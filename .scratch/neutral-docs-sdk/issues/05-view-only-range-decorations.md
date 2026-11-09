# 05: 公开通用文字范围装饰

## What to build

宿主通过浏览器和 Qt SDK 注册、更新、移除文字范围装饰。装饰可按宿主提供的匹配规则或范围显示背景、文字颜色、下划线和提示，适用于可编辑及只读文档，仅影响编辑器视图。对应原需求第 7 项。

## Acceptance criteria

- [ ] 提供公开的装饰注册、替换、更新和移除能力；支持独立装饰集合及按文档实例隔离。
- [ ] 宿主或扩展提供匹配规则或文字范围及样式，SDK 不内置业务语法、字段目录、专属节点或专属属性面板。
- [ ] 装饰覆盖实际文字范围并支持跨字体、粗体等格式片段；加载、输入、粘贴、撤销、重做及 Agent 修改后映射或重算。
- [ ] 全部正文仍完整显示并保留光标移动、选择和直接编辑，不隐藏分隔符、不替换简称、不创建不可编辑原子节点。
- [ ] 装饰不改变文档模型、DOCX 内容、复制粘贴文字、原生查找替换、格式继承、dirty 或撤销记录；注册和移除本身不产生文档修改。
- [ ] 只读文档可显示装饰；关闭或切换文档后清理规则与范围，旧范围不能作用于新文档。
- [ ] 装饰不进入普通复制、保存、打印及导出；比较有无装饰的打印/PDF 内容或渲染，证明显示样式没有泄漏。
- [ ] 浏览器及真实 Qt 公共接口均验证跨格式显示、只读、手输与 UI 插入等价、编辑后刷新、规则移除、文档切换和保存重开。
- [ ] 该能力独立于错误诊断，合法文字也能装饰；不要求宿主每次修改都通过 MCP 读取全文。

## Blocked by

None (can start immediately).

## Publication status

Published: https://github.com/lanbingtech/foraoffice/issues/41

Parent: https://github.com/lanbingtech/foraoffice/issues/38

Label: `ready-for-agent`. The user explicitly authorized implementation after publication.

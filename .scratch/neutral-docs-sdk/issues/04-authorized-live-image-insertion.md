# 04: 受授权本地图片与宿主素材插入实时文档

## What to build

Agent 或宿主通过原有图片工具引用本地路径或宿主素材，文件服务读取后复用手动插图流程，将图片插入当前文档并正常保存重开。模型无需搬运 base64，原始路径不成为重开文档的依赖。对应原需求第 5 项。

## Acceptance criteria

- [ ] 现有插图工具兼容原有 URL 输入，并接受明确的本地路径或不透明宿主素材引用；素材解析通过公开宿主服务接入。
- [ ] 本地读取复用规范路径、readRoots 或单文件 grant 校验；越界、撤权、无效文件及不支持的图片内容被拒绝。
- [ ] 读取图片不扩大写权限；工具和模型不能自行授予文件权限，SDK 不推断业务权限。
- [ ] 复用手动插图的资源处理、图片校验、尺寸和文档持久化规则，保持现有工具的取消、只读和旧文档拒绝语义。
- [ ] 图片实际插入当前实时文档，支持原有撤销与保存重开；不使用 CLI 直接改写已打开文件。
- [ ] 浏览器公开宿主素材解析和真实 Qt 本地路径插图均有验证；保存的 DOCX 包内资源与图片显示正确，源文件移动或删除后不依赖原路径。
- [ ] 原有 HTTP(S) 与 data URL 插图回归通过，保留原有媒体限制并记录不同来源的实际限制。

## Blocked by

- 01: Qt 宿主逐项替换默认文档服务。

## Publication status

Published: https://github.com/lanbingtech/foraoffice/issues/43

Parent: https://github.com/lanbingtech/foraoffice/issues/38

Label: `ready-for-agent`. The user explicitly authorized implementation after publication.

# 03: 公开原生查找替换与逐次匹配定位

## What to build

浏览器和 Qt 宿主直接调用编辑器已有查找替换能力，获取匹配及替换结果，并让宿主侧栏逐次定位重复文字。SDK 与界面使用同一引擎和规则，不需要 Agent 或 MCP 中转。对应原需求第 3 项及外部定位补充。

## Acceptance criteria

- [ ] 公开已有查找模式、选项、匹配范围、匹配数量及替换数量；查找范围、正则语义、替换表达式、格式继承与撤销均与 ForaOffice 当前界面一致。
- [ ] 查找与替换复用同一原生引擎；现有按片段的 MCP 字面替换不作为此能力的替代证明。
- [ ] 宿主可指定某一次匹配，滚动并选中或临时高亮；三处相同文字能够分别定位，包括跨字体或粗体片段的匹配。
- [ ] 结果绑定当前文档实例及有效内容状态；编辑后由编辑器维护引用或明确报告失效；切换文档拒绝旧引用。
- [ ] 定位支持只读文档，可选择是否移入键盘焦点；连续操作宿主侧栏不会改正文、dirty 或撤销记录。
- [ ] 批量替换使用原始匹配集合，保持现有原生行为，不递归替换新写入值；宿主业务填充值按现有表达式规则自行转义。
- [ ] 公开真实支持范围及限制；不增加原界面没有的搜索区域或匹配规则，不承诺章节、页码和屏幕坐标。
- [ ] 浏览器和真实 Qt 公开接口均验证逐次定位、只读、跨格式、失效引用、原生替换表达式及撤销；无需访问私有状态。

## Blocked by

None (can start immediately).

## Publication status

Published: https://github.com/lanbingtech/foraoffice/issues/40

Parent: https://github.com/lanbingtech/foraoffice/issues/38

Label: `ready-for-agent`. The user explicitly authorized implementation after publication.

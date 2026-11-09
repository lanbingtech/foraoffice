# 01: Qt 宿主逐项替换默认文档服务

## What to build

Qt 宿主可以通过公开 SDK 替换打开、保存、另存和导出等单项服务，同时继续使用其他默认原生服务。一次操作从编辑器入口到宿主执行再到界面结果完整可用，宿主取消或失败时不会意外启动本地操作。对应原需求第 1 项。

## Acceptance criteria

- [ ] 提供通用、公开、按服务粒度注册和移除覆盖的入口；未配置的服务使用原有默认实现。
- [ ] 宿主成功、取消、失败和禁用的结果分别得到正确处理；取消、异常和失败均不触发默认服务回退。
- [ ] 禁用在命令或服务执行边界生效，菜单、快捷键和相关工具调用均无法绕过；不能只用 CSS 隐藏入口。
- [ ] 原有打开、保存、另存、导出能力及默认浏览器宿主服务注入保持兼容；不引入业务服务名称或业务对象。
- [ ] 使用真实 Qt 组件演示一个宿主覆盖的打开与保存流程，并覆盖取消、失败、禁用和未配置时的默认行为；浏览器公开服务契约有对应回归。
- [ ] 不改变已有 Qt 工作线程生命周期和正常界面线程分工。

## Blocked by

None (can start immediately).

## Publication status

Published: https://github.com/lanbingtech/foraoffice/issues/39

Parent: https://github.com/lanbingtech/foraoffice/issues/38

Label: `ready-for-agent`. The user explicitly authorized implementation after publication.

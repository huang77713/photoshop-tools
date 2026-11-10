# Photoshop Tools 2.1.0

一个 Photoshop UXP 插件、一个面板、四种功能，通过左上角下拉菜单在同一面板中切换。

## 此版本针对什么问题

2.0.0 在用户的 Photoshop 27.5.0 环境中出现安装后宿主崩溃。提供的 Adobe 原生崩溃报告指出 `EXCEPTION_ACCESS_VIOLATION (0xc0000005)`，堆栈出现 `torq::seal_napi::Context::protect` 以及 Photoshop 字体组件。此报告不足以确定某一行 JavaScript 是根因。

为隔离启动时的问题，2.1.0 采用 **懒加载界面 + 懒加载功能代码**：首次打开面板时只加载小型 HTML 下拉菜单，不创建九宫格、字库、拆分或文字导出 UI，也不调用任何 Photoshop 处理 API。选择某个工具后才创建对应 HTML 和执行其功能脚本。

## 结构

- `manifest.json`：一个 UXP panel
- `index.html`：约 1.4 KB 启动界面，只有功能选择菜单
- `main.js`：简单选择器和按需加载程序
- `styles.css`：四个功能样式隔离；处理面板尺寸
- `features-ui/`：原始四个工具 HTML 的按需加载模块
- `features/`：从四个原始仓库重新整理的四个功能脚本
- `icons/`：已配置的主插件图标及四个功能图标

处理算法和 Photoshop API 操作基本保留原样；仅为同页运行改写 DOM 作用域和独立插件启动入口。

## 安全的验证步骤

由于此前出现过宿主进程崩溃，**请先卸载旧测试版本，不要直接重复安装 CCX**。

1. 关闭 Photoshop，确认旧版 Photoshop Tools 已从 UXP Developer Tool 卸载。重启 Photoshop。
2. 用 UXP Developer Tool 加载最新版仓库根目录 `manifest.json`，先不要 Package。
3. 打开 Photoshop Tools 面板。不点击任何功能时，应该只出现「选择工具」和提示文字。
4. 如果在第 3 步 Photoshop 就崩溃，请保存本次崩溃报告和 UXP Developer Tool Debug Console 日志。此时尚未调用四个功能模块，因此应优先排查插件加载环境、资源和宿主问题。
5. 如果第 3 步正常，打开下拉并逐个选择工具。记录首次导致崩溃或报错的那个工具，再检查其逻辑。
6. 四个工具都确认可以运行后，再打包 CCX。

这是隔离问题用的重构版本，不代表已在用户电脑上的 Photoshop 实际验证成功。

## 图标

- `icons/plugin.png`：48×48
- `icons/nine-slice.png`：23×23
- `icons/sprite-font.png`：23×23
- `icons/remove-bg.png`：23×23
- `icons/text-cutter.png`：23×23

# Photoshop Tools

把以下 4 个 Photoshop UXP 增效工具整合为一个插件，只需安装一次：

1. Nine Slice Resize
2. 图片数字排版器 / Sprite Font Composer
3. 透明对象拆分工具
4. 文字批量切图

## 结构

- `manifest.json`：统一插件清单，包含 1 个 panel entrypoint 和 4 个可切换工具
- `index.html`：4 个工具的独立界面模板
- `main.js`：注册单个 Photoshop Tools panel，在顶部标签栏切换 4 个工具，并将各自 UI 挂载到独立容器
- `tools/nine-slice/index.js`
- `tools/sprite-font/index.js`
- `tools/remove-bg/index.js`
- `tools/text-cutter/index.js`
- `styles.css`：统一且隔离后的面板样式
- `icons/`：图标占位目录

## 图标替换

当前图标是占位图。直接用你自己的 PNG 覆盖同名文件即可：

- `icons/plugin.png`：插件列表图标，当前 48×48
- `icons/nine-slice.png`：Nine Slice Resize 面板图标，当前 23×23
- `icons/sprite-font.png`：图片数字排版器面板图标，当前 23×23
- `icons/remove-bg.png`：透明对象拆分工具面板图标，当前 23×23
- `icons/text-cutter.png`：文字批量切图面板图标，当前 23×23

建议新图标保持相同尺寸和文件名，这样无需修改 `manifest.json`。

## 功能保护原则

本整合版本没有改动四个工具原本的 Photoshop 核心处理流程、算法、参数逻辑、图层操作、文件导入导出逻辑。

为了让四个工具能够在同一个插件中共存，只做了以下整合层修改：

- 把每个工具的 DOM 查找范围限制在自己的工具容器内，避免重复 ID 冲突。
- 把原本各自独立的加载入口改为由统一的 `main.js` 挂载。
- 移除子工具内部重复的 `entrypoints.setup()`，由统一入口只注册一次。
- 保留各工具原有 localStorage key，避免设置互相覆盖。

## 安装

用 UXP Developer Tool 加载本仓库根目录，或后续打包为 CCX 后安装。

Photoshop 中只显示一个 Photoshop Tools Panel。面板顶部有 4 个工具切换按钮，安装一次即可使用全部工具。

## 统一面板（v1.0.1）

只有一个 Photoshop Tools 面板，顶部以 2×2 按钮切换：九宫格拉伸、图片数字排版、透明对象拆分、文字批量切图。首次切换时才初始化对应工具，之后切换保持页面输入和预览状态。为避免输入框错位，九宫格的 L/R/T/B 和 W/H 改用两列 Grid 布局。

原 Photoshop 处理算法及操作逻辑没有改动。本版本尚需在真实 Photoshop / UXP Developer Tool 中进行交互回归验证。

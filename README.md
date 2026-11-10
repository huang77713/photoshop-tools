# Photoshop Tools

把以下 4 个 Photoshop UXP 增效工具整合为一个插件，只需安装一次：

1. Nine Slice Resize
2. 图片数字排版器 / Sprite Font Composer
3. 透明对象拆分工具
4. 文字批量切图

## 结构

- `manifest.json`：统一插件清单，包含 4 个 panel entrypoint
- `index.html`：4 个 panel 的独立界面模板
- `main.js`：统一注册 4 个 panel，并把各自 UI 挂载到独立 rootNode
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

- 把每个工具的 DOM 查找范围限制在自己的 panel rootNode 内，避免重复 ID 冲突。
- 把原本各自独立的加载入口改为由统一的 `main.js` 挂载。
- 移除子工具内部重复的 `entrypoints.setup()`，由统一入口只注册一次。
- 保留各工具原有 localStorage key，避免设置互相覆盖。

## 安装

用 UXP Developer Tool 加载本仓库根目录，或后续打包为 CCX 后安装。

Photoshop 中会显示 4 个独立 Panel，但它们属于同一个插件，因此只需要安装一次。

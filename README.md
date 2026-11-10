# Photoshop Tools 2.0.0

一个 Photoshop UXP 增效工具，包含 4 个功能：
1. 九宫格拉伸（Nine Slice Resize）
2. 图片数字排版（Sprite Font Composer）
3. 透明对象拆分
4. 文字批量切图

## 使用方式

只需安装 **一个插件**。Photoshop 中只显示一个 Photoshop Tools 面板。点击面板左上角的“选择工具”下拉菜单，在**同一个面板里切换功能**，风格参考 Cutterman。

## 2.0.0 全新实现

此前版本曾发生面板空白和 Photoshop 崩溃。2.0.0 已放弃原来的多面板和动态 UI 挂载架构。

本次重新读取了四个独立仓库的 `index.html`、`index.js`、CSS 和 manifest。使用四个原始 HTML 重新建立一个静态单页界面，重新整理并隔离四套原始 CSS，并直接从原始功能 JS 重建四份模块，未在旧版合并模块上继续打补丁。

- `manifest.json`：只声明一个 Photoshop Panel
- `index.html`：纯静态 HTML，包含一个下拉菜单和四个功能容器
- `main.js`：简单的下拉切换与单个功能按需加载
- `styles.css`：从原始四份 CSS 重新隔离整理
- `features/nine-slice.js`：九宫格算法及 Photoshop 图层操作
- `features/sprite-font.js`：图片字库识别及生成
- `features/remove-bg.js`：透明元素识别、拆分、转智能对象
- `features/text-cutter.js`：文字模板与 PNG 批量导出
- `icons/`：主图标与四个菜单图标

四份功能 JS 原有 Photoshop 处理逻辑保持不变，只把 DOM 查询改成对应功能容器内查询，取消独立插件注册或 window load 入口，并由主菜单首次选择时初始化；不同功能的重复 ID 不会互相干扰。

## 测试与安装

建议先使用 UXP Developer Tool 打开仓库根目录的 `manifest.json` 进行开发模式测试，不要马上打包 CCX。

依次测试：
1. 打开面板后是否显示“选择工具”和菜单。
2. 点击菜单是否能在同一个面板切换。
3. 九宫格能否读取图层、预览、生成新图层和新文档。
4. 图片数字排版能否导入字库并生成。
5. 透明对象能否拆分并转换为智能对象。
6. 文字批量切图能否选择文件夹并导出 PNG。

**重要：** 该版本完成了 GitHub 文件引用与静态结构检查，但尚未在真实 Photoshop 环境中进行运行回归。若仍出现异常，请优先提供 UXP Developer Tool 的 Debug Console 报错，而非继续反复安装旧版 CCX。

## 图标

- `icons/plugin.png`：48×48 主图标
- `icons/nine-slice.png`：23×23
- `icons/sprite-font.png`：23×23
- `icons/remove-bg.png`：23×23
- `icons/text-cutter.png`：23×23

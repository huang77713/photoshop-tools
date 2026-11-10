# Photoshop Tools

Photoshop UXP 增效工具，正式版本 **1.0.0**。一个插件、一个 Photoshop 面板，可在左上角下拉菜单中切换四项功能：

- 九宫格拉伸（Nine Slice Resize）
- 图片数字排版（Sprite Font Composer）
- 透明对象拆分
- 文字批量切图

## 安装和使用

从 `main` 分支下载完整仓库，用 Adobe UXP Developer Tool 加载根目录的 `manifest.json`。确认运行正常后可以通过 UXP Developer Tool 打包 CCX。只需安装一个插件。

## 文件

- `index.html`：单一面板和切换菜单
- `menu.js`：四工具按需初始化与切换，保留下拉菜单层级处理
- `extra-features.css`：透明对象拆分和文字批量切图的隔离样式及滚动修复
- `nine-slice.js`：九宫格拉伸
- `sprite-font.js`：图片数字排版
- `remove-bg.js`：透明对象拆分
- `text-cutter.js`：文字批量切图
- `icons/panel.png` 和 `icons/panel@2x.png`：同一工具箱图标的 23/46 px 侧边栏版本
- `icons/plugin.png` 和 `icons/plugin@2x.png`：同一工具箱图标的 24/48 px 插件列表版本

## 发布说明

v1.0.0 从经用户在 Photoshop 实际测试的 `diagnostic/four-features-test`（v0.0.10）发布；保持已经验收的四个功能、界面布局、滚动、下拉遮挡修复和统一工具箱图标。正式版只调整插件清单中的名称、ID、版本号及入口面板 ID，不修改四个 Photoshop 功能脚本。

后续开发请在独立测试分支进行，验证后再合并到 `main`。

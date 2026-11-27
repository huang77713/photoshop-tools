# Photoshop Tools

Photoshop UXP 增效工具箱。一个插件、一个面板，通过左上角菜单切换 **8 项功能**。

- 正式分支：`main`
- 插件清单版本：`1.0.0`
- Photoshop：25.0.0 及以上

## 功能列表

| 工具 | 主要功能 |
| --- | --- |
| 九宫格拉伸（Nine Slice Resize） | 九宫格尺寸调整、双预览、对称边距、原位生成及一步撤销 |
| 图片数字排版（Sprite Font Composer） | 图片字库识别与拼接排版；放到画布/选区/选中图层并可原位替换；输出独立图层、合并图层或智能对象；数字等宽 |
| 透明对象拆分 | 按透明区域分离独立对象 |
| 文字批量切图 | 文字素材批量切图与导出 |
| 智能排列（Smart Arrange） | 复制排列、横向/纵向/网格布局及现有对象整理 |
| 批量尺寸统一（Batch Visible Resize） | 按可见像素批量调整尺寸及等比缩放 |
| 矩形框工具（Bounds Frame） | 生成可编辑矩形形状，支持统一尺寸及整数坐标 |
| 批量修改文字（Text Layer Manager） | 选中/全部/可见文字图层筛选、统一替换、手动换行预览、长文字缩小及高级查找替换 |

## 安装与更新

首次安装，在 PowerShell 中执行：

```powershell
git clone --branch main https://github.com/huang77713/photoshop-tools.git
cd photoshop-tools
```

使用 Adobe UXP Developer Tool 加载仓库根目录的 `manifest.json`。加载成功后，在 Photoshop 中打开 Photoshop Tools 面板。确认运行正常后，可通过 UXP Developer Tool 打包 CCX，只需安装一个插件。

已克隆仓库的用户，在仓库目录执行：

```powershell
git switch main
git pull --ff-only origin main
```

更新后在 UXP Developer Tool 中重新加载插件；使用 CCX 安装的用户需重新打包并安装。

## 文件结构

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | 插件清单、入口及权限 |
| `index.html` | 统一面板及工具界面 |
| `menu.js` | 工具切换与初始化 |
| `nine-slice.js / .css` | 九宫格拉伸 |
| `sprite-font.js / .css` | 图片数字排版 |
| `remove-bg.js` | 透明对象拆分 |
| `text-cutter.js` | 文字批量切图 |
| `extra-features.css` | 拆分与切图公共样式 |
| `text-cutter-ui.css` | 文字切图界面优化 |
| `smart-arrange.js / .css` | 智能排列 |
| `visible-resize.js / .css` | 批量尺寸统一 |
| `bounds-frame.js / .css` | 矩形框工具 |
| `text-layer-manager.js / .css` | 批量修改文字 |
| `icons/` | 统一插件与面板图标 |
| `AGENTS.md` | 开发与新增工具维护指南 |

## 正式版更新记录

- 2026-11-27：图片数字排版改版：样式迁移至独立 `sprite-font.css`，固定底部生成按钮；预览改为清晰的无损 PNG 且不再限制 60 个字符；字库图片只读取一次；一步撤销；删除字库二次确认；字符映射自动保存；新增放置位置（画布/选区/选中图层）与原位替换、三种输出方式、数字等宽。
- 2026-11-27：九宫格拉伸界面改版：样式迁移至独立 `nine-slice.css`，Photoshop 原生深灰风格；新增对称边距、方向键微调、透明格子预览、生成到原图层位置（可超出画布）、一步撤销，并记住拉伸/平铺与对称设置。
- 2026-11-20：发布批量修改文字工具（[#4](https://github.com/huang77713/photoshop-tools/pull/4)），包含手动换行预览及长文字适配。
- 2026-11-14：加入矩形框工具，优化工具选择菜单，矩形尺寸规范为偶数整数、坐标为整数。
- 2026-11-13：发布智能排列与批量尺寸统一（[#1](https://github.com/huang77713/photoshop-tools/pull/1)），优化智能排列（[#2](https://github.com/huang77713/photoshop-tools/pull/2)）及文字批量切图界面（[#3](https://github.com/huang77713/photoshop-tools/pull/3)）。
- 初始版本：整合九宫格拉伸、图片数字排版、透明对象拆分和文字批量切图，统一面板、滚动、菜单及图标。

以上为代码发布记录，不代表全部功能已完成所有 Photoshop 环境下的回归测试。最新文字自动适配功能仍需实际使用验证。

## 开发与分支管理

- `main` 是唯一正式发布分支，日常使用从该分支下载。
- 新功能和修复从最新 `main` 创建独立 `test/*` 分支，诊断分支仅用于问题排查。
- Photoshop 实际测试通过后合并至 `main`，同步更新 README 与发布记录。
- 确认测试分支不含未发布的有效修改后再删除，避免误删尚未合并的工作。
- 新增工具遵循 `AGENTS.md`，保持各工具逻辑隔离，避免影响既有功能。
- 插件版本号以 `manifest.json` 为准；正式打包发布时按实际变更维护版本。


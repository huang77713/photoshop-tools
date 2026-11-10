# Photoshop Tools — 一套插件，四种功能

Photoshop UXP 合并增效工具，参考 Cutterman 左上角下拉选择器：

- 九宫格拉伸（Nine Slice Resize）
- 图片数字排版（Sprite Font Composer）
- 透明对象拆分
- 文字批量切图

**一个安装包、一个 Photoshop 面板。**面板上方点击“选择工具”弹出菜单，选择后直接在原面板内容区域切换。不是跳转窗口，也不是四个独立插件。

## 代码结构

- `manifest.json` — 只有一个 UXP 面板入口 `photoshopToolsPanel`
- `index.html` — 静态下拉选择器和四个隔离的工具容器
- `main.js` — 菜单切换和首次选择时按需初始化工具
- `styles.css` — CSS 样式，工具区域单独滚动
- `tools/nine-slice/index.js` — 九宫格核心代码
- `tools/sprite-font/index.js` — 图片数字核心代码
- `tools/remove-bg/index.js` — 透明对象拆分核心代码
- `tools/text-cutter/index.js` — 文字批量切图核心代码

整合只对各工具 JavaScript 的页面挂载、DOM 查找作用域和初始化入口进行了包装。没有主动更改 Photoshop 图层处理算法、输出选项和文件操作逻辑。

## 图标

图标在 `icons/` 文件夹：

- `plugin.png` 48×48，插件列表主图标
- `nine-slice.png` 23×23，九宫格
- `sprite-font.png` 23×23，图片数字排版
- `remove-bg.png` 23×23，透明对象拆分
- `text-cutter.png` 23×23，文字批量切图

替换同名同规格 PNG 即可。

## 安装和测试

建议先关闭并卸载先前发生异常的 Photoshop Tools CCX，在 UXP Developer Tool 中以本仓库根目录的 `manifest.json` 加载当前版本进行调试。确认 UI 正常和四个核心操作都能运行后，再从 UXP Developer Tool 打包 CCX。

注意：静态代码检查不能代替 Photoshop 实机回归测试。此前版本曾出现宿主崩溃，本版本针对 UXP 动态模板风险采用静态界面和按需模块加载，但尚未经过用户机器上的 Photoshop 完整验证。

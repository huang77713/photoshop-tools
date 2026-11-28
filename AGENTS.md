# AGENTS.md — Photoshop Tools 代码维护与新增功能规范

> **给 AI 编程助手、外部开发者和后续维护者的强制阅读文件。**
>
> **在新增工具、优化界面、修复 Bug、提交 GitHub 代码之前，必须先完整阅读本文件。**
>
> 本文件以仓库当前结构为准。**未经用户明确授权，不得重构现有工具、移动文件、修改无关代码或直接发布正式版。**

## 0. 最重要的规则：最小范围修改

1. **用户要求“新增一个工具”时，只允许创建新工具文件，并修改接入新工具必需的公共文件。**
2. **用户要求“只改界面”时，只允许修改指定工具的界面 HTML/CSS；禁止顺手重写它的功能逻辑。**
3. **用户要求“只改功能”时，只允许修改指定工具的 JS 及必要的对应界面；禁止影响其他工具。**
4. **用户明确说“不要动某个工具”时，绝对禁止修改该工具的 JS、CSS、HTML 片段、默认行为及相关配置。**
5. **不要借本次需求重命名、格式化、整理、迁移、抽象或批量替换全仓库代码。** 即使看见旧代码不优雅，也不要擅自修复。
6. **功能开发只在测试分支提交**；除非用户明确要求正式发布或直接维护正式版文档，否则不得修改、合并或推送 `main`。
7. 如果必须修改本文件规则所禁止的范围，**先向用户说明原因并获得明确授权**，不要自行扩大范围。

## 1. 项目基本信息

- 仓库：`huang77713/photoshop-tools`
- 技术：Adobe Photoshop UXP Panel，HTML + CSS + JavaScript，使用 `require("photoshop")` 访问 Photoshop API。
- 单面板入口：`manifest.json` 中 `main: "index.html"`。
- 正式发布分支：`main`。**开发任务默认只读，不直接改动；正式发布及文档维护须经用户授权。**
- 新任务从最新 `main` 创建独立 `test/<feature>` 分支；仅在继续同一未完成任务时使用对应已有测试分支。不得默认沿用旧测试分支。
- 截至 2026-11-27，`main` 已发布 **8 个工具**，插件清单版本为 `1.0.0`。以后以最新 `main` 实际代码、菜单及清单为准，更新本表，不依赖旧分支或历史文档。
- Windows/Photoshop 开发环境：通过 UXP Developer Tool 加载仓库根目录的 `manifest.json`。

### 当前八个工具和对应代码

| 中文菜单 | 核心逻辑文件 | 样式文件 | HTML 所在位置 |
|---|---|---|---|
| 九宫格拉伸 | `nine-slice.js` | `nine-slice.css`（`#nineSliceView` 作用域，图标 `icons/ns-link-*.png`） | `index.html` 的 `#nineSliceView` |
| 图片数字排版 | `sprite-font.js` | `sprite-font.css`（`#spriteFontView` 作用域；`menu.js` 为其切换 `#bodyArea.sprite-active`） | `index.html` 的 `#spriteFontView` |
| 透明对象拆分 | `remove-bg.js` | `remove-bg.css`（`tsp-` 前缀；`menu.js` 为其切换 `#bodyArea.split-active`；用 `#bodyArea #removeBgView` 覆盖 `extra-features.css` 中的旧 `!important` 规则） | `index.html` 的 `#removeBgView` |
| 文字批量切图 | `text-cutter.js` | `extra-features.css`、`text-cutter-ui.css` | `index.html` 的 `#textCutterView` |
| 智能排列 | `smart-arrange.js` | `smart-arrange.css` | `index.html` 的 `#smartArrangeView` |
| 批量尺寸统一 | `visible-resize.js` | `visible-resize.css` | `index.html` 的 `#visibleResizeView` |
| 边界框（矩形框工具） | `bounds-frame.js` | `bounds-frame.css`（`menu.js` 为其切换 `#bodyArea.frame-active`） | `index.html` 的 `#boundsFrameView` |
| 文字图层管理（批量修改文字） | `text-layer-manager.js` | `text-layer-manager.css` | `index.html` 的 `#textLayerManagerView` |

**重要：** 上表列出的核心功能文件均为**已有功能保护范围**。新增任何工具时，不能为了接入新功能而修改它们。

## 2. 新增任意工具：允许改哪里？

假设新工具叫“示例工具”，英文标识 `example-tool`，容器 ID `exampleToolView`：

### 允许新增的文件

- `example-tool.js`：新工具全部核心功能逻辑。
- `example-tool.css`：新工具的独立样式。
- 如果确实必要，可以新增仅供该工具使用的图标或其他素材到 `icons/`（须提供合法的文件及路径）。

### 允许有限修改的现有文件

**A. `index.html` — 只修改以下三处与新工具有关的内容：**

1. 在已有样式 `<link>` 附近**新增一行**：
   ```html
   <link rel="stylesheet" href="example-tool.css">
   ```
2. 在 `#dropdown` 菜单中**增加一个选项**，不要改动、删除、移动已有菜单项：
   ```html
   <div class="item" data-name="示例工具"><span>示例工具</span><span class="check"></span></div>
   ```
3. 在 `#bodyArea` 内**新增独立视图容器**：
   ```html
   <div id="exampleToolView" style="display:none">
     <!-- 仅该工具的 HTML 控件，所有 id 必须唯一 -->
   </div>
   ```

**B. `menu.js` — 只扩展菜单识别、视图显隐与新工具的按需初始化：**

现有项目采用在菜单中识别 `data-name`、切换对应 View 的 `display`，首次点击时 `require("./xxx.js")(view)` 初始化的方法。新增工具时需要：

1. 在已有 `loaded... = false` 区域**新增** `loadedExampleTool = false`。
2. 在菜单点击处理器中**新增** `showExampleTool = name === "示例工具"`。
3. 获取独立容器 `document.getElementById("exampleToolView")`，并按当前选项切换 `display`。
4. 扩展 `showFallback` 判断，避免选择新工具仍显示“后续接入”的占位信息。
5. 添加新工具的**独立懒加载代码**：
   ```js
   if (showExampleTool && !loadedExampleTool) {
     try {
       require("./example-tool.js")(exampleView);
       loadedExampleTool = true;
     } catch (error) {
       console.error("[Photoshop Tools] Example Tool failed:", error);
       // 参照现有工具的错误展示方式处理
     }
   } else if (
     showExampleTool &&
     loadedExampleTool &&
     typeof exampleView.__exampleToolActivate === "function"
   ) {
     exampleView.__exampleToolActivate();
   }
   ```
   此代码只是接入结构示意；实际变量 `exampleView` 必须先定义，并遵守当前 `menu.js` 的显示、错误处理逻辑。

**禁止修改**：其他工具已有 `require` 路径、初始化标志、显示逻辑、下拉菜单的 `setMenuOpen` 行为、`#bodyArea` 的滚动行为及现有工具的事件监听。

**C. `manifest.json` — 新增内部工具时默认不需要修改。**

这是一个共享的 Photoshop UXP Panel，新增面板内菜单选项并不需要新增 UXP entrypoint。不得因为新增工具而随意修改插件 ID、名称、版本、图标、入口 ID、权限或最小 Photoshop 版本。只有**确有新权限、资源或入口需求**，并得到用户授权，才可修改。

### 新工具 JS 约定

```js
/* Example Tool - Photoshop UXP */
module.exports = function initExampleTool(root) {
  "use strict";
  const photoshop = require("photoshop");

  // 所有 DOM 查询应限制在 root 内，避免与其他工具的控件重名。
  const $ = id => root.querySelector("#" + id);

  // 仅绑定当前工具的事件和状态。
  // Photoshop 文档修改应遵守 UXP/executeAsModal 约束。
  root.__exampleToolActivate = function () {
    // 切换回本工具时才需要执行的轻量逻辑（可选）。
  };
};
```

- 独立模块导出与现有 `require("./example-tool.js")(exampleView)` 一致。
- 使用独一无二的 DOM ID、JS 状态变量、CSS 命名空间，避免污染其他工具。
- 新工具的 CSS 必须以 `#exampleToolView` 为作用域前缀。
- 避免对 `body`、`html`、`button`、`input`、`section` 等写全局 CSS。
- 所有按钮必须真实可用；不允许仅做一个显示好看但功能未连接的控件。

## 3. 文件修改权限速查

| 文件/范围 | 新增工具 | 修改某个现有工具 | 备注 |
|---|---|---|---|
| 新工具 `.js` / `.css` | ✅ 新增 | 不适用 | 最主要开发位置 |
| `index.html` | ✅ 仅新菜单、新容器、新样式引用 | ✅ 仅指定工具的 HTML 区域 | **禁止全文件重写** |
| `menu.js` | ✅ 仅为新工具扩展路由/显示/加载 | ⚠️ 仅在明确需要时 | 保护旧工具切换逻辑 |
| 指定工具的 JS / CSS | ❌（不是新工具时） | ✅ 用户明确授权后 | 修改前备份/比较 |
| 其他工具 JS / CSS | ❌ | ❌ | 没有明确授权绝不能改 |
| `manifest.json` | ❌ 默认禁止 | ❌ 默认禁止 | 仅真实配置需求且经授权 |
| `icons/` 现有素材 | ❌ 禁止覆盖 | ❌ 禁止覆盖 | 新素材使用新文件名 |
| `main` 分支 | ❌ | ❌ | 正式发布或文档维护必须经用户明确授权 |
| `AGENTS.md` | ❌ 默认不修改 | ❌ 默认不修改 | 维护规范的更改需用户授权 |

## 4. 已有工具的特殊保护说明

- **智能排列**：`smart-arrange.js` 与 `smart-arrange.css` 含已经迭代过的组复制、嵌套组、对象顺序、间距和预览逻辑。**新增其他工具时，严禁更改这两个文件。**
- **批量尺寸统一**：`visible-resize.js` 的可见像素测量、临时文档流程和独立缩放逻辑与智能排列不同。不要把两套逻辑合并，也不要擅自复用导致两个工具耦合。
- **九宫格拉伸**：原有控件 ID 和预览/分割线/输出区域需要保留。按钮使用 `div[role=button]`（UXP 会忽略原生 `<button>` 的字体样式），输入框保留上下内边距，避免原生文字框盖住边框。
- **图片数字排版**：原有数字素材读取、排列与输出逻辑需要保留。字形像素在首次读取字库后缓存；预览与合并输出共用 `computeLayout` / `composeRGBA`，预览以插件内 PNG 编码显示；生成须保持一步撤销。
- **透明对象拆分**：保留透明背景处理、可见像素识别与导出流程。输出只复制本对象拥有的像素（`labels` 归属图）及无归属的柔边像素；拆分前须核对识别结果未变化；保持一步撤销与失败回滚。`extra-features.css` 仍被文字批量切图使用，修改时不要删除其中 `#textCutterView` 规则。
- **文字批量切图**：保留文字提取、预览和导出流程。
- **边界框**：保留可编辑矢量矩形、颜色选择、统一宽高及边界检查；尺寸为偶数整数，坐标为整数，不得擅自改为栅格图层或改变尺寸规范。精确测量须逐对象按原尺寸读取（超过 4096px 才缩小并标注）。切图按同层级「对象名 - 边界框」配对，底框命名规则不可随意更改；切图只在临时副本中进行，不修改原文档，同名文件自动编号不覆盖。
- **文字图层管理**：保留选中/全部/可见文字图层筛选（包含隐藏父组判断）、统一替换、手动换行和实时预览、可选长文字缩小、高级查找替换、原图层名称与文字样式保护及失败回滚。不得随意重置字体、字号、颜色或段落样式；仅在用户启用相关功能时改变相应属性。
- 不要以“统一风格”“优化架构”“提升性能”为理由同时改动多个工具，除非用户确实要求跨工具改造。

## 5. Photoshop UXP 特别注意事项

1. **不是普通 Chrome 网页。** 某些 CSS Grid 布局和输入控件层级行为与浏览器不同；尽可能使用已验证的 Flex、明确宽度与独立的 CSS 命名空间。当前项目曾出现布局导致按钮不可见的问题。
2. 下拉菜单涉及 UXP 控件覆盖层级问题，`menu.js` 的 `setMenuOpen` 会通过 `bodyArea.style.visibility` 处理。**不要删除或随意重写它。**
3. 新面板控件要保证窄尺寸（约 280–390px）下可用，并能正常滚动；不能只在宽浏览器窗口检查。
4. Photoshop 文档改动应放在适当的 `core.executeAsModal` 中；批量操作按需使用历史记录管理，避免修改未选中的图层或破坏 PSD 结构。
5. 处理图层、图层组、剪切蒙版、智能对象时，不能随意把它们扁平化、栅格化或解组。用户未授权时，绝不破坏性处理。
6. 不能用图层几何边界假冒“实际可见像素”。若功能承诺测量可见像素，必须采用可信的合成/Alpha 测量方案，并说明性能与兼容限制。
7. 对 SVG：可用作简单图标，但不能默认复杂 SVG 滤镜、动画或全部浏览器特性在 UXP 中都可正常工作；需在实际 UXP 面板验证。
8. 重视图层选择状态、文档变化、临时文件清理、失败提示、撤销与错误恢复。
9. **不得宣称“Photoshop 测试通过”**，除非确实在 Photoshop 实际运行并验证。静态代码检查不等于 UXP 实机通过。

## 5.1 UI 设计与交互验收规范

- 以 Photoshop 原生深灰面板及已有成熟工具为参考，统一字号、字重、颜色、控件高度和圆角，不额外引入花哨装饰。用户提供参考图时优先遵循参考。
- 面板左右边距、标签、输入框和按钮须对齐；同一组控件使用一致间距，按钮及输入框不得黏连。使用 UXP 实际支持的间距实现方式，不能只依赖普通浏览器中的 CSS 效果。
- 标签文字清晰可读，禁用状态与正常状态可辨；输入框不缺失、不截断内容，长标签允许合理换行。
- 单选、复选、图标按钮的完整可见区域均须可点击，包括圆点、图标和文字；状态与实际功能一致。
- 优先使用已验证的原生 Spectrum 控件或兼容实现；图标简洁且能实际显示，不得出现空白图标、异常白框或重复装饰。
- 紧凑但不拥挤，避免大按钮堆叠和无意义空白；预览应完整显示、保持比例，不能被裁切。
- 工具选择菜单应处于正确层级，在面板高度允许时显示全部选项；空间不足时才滚动。内容区独立滚动，不得遮挡菜单。
- 交互不得无故导致 Photoshop 画布闪黑、预览丢失、选项消失或破坏当前文档。检查窄面板及不同高度下的表现。
- UI 修改须核对真实 UXP 表现；未进行 Photoshop 实机检查时明确说明，禁止将普通网页预览视为验收通过。

## 6. 每次改动的标准流程（AI 必须遵守）

**开始前：**

1. 先读 `AGENTS.md`，再读用户本次要求涉及的具体文件。
2. 明确本次要动哪些文件，给出最小修改清单。
3. 检查远程最新 `main`、当前分支及未提交修改。新任务从最新 `main` 创建独立测试分支；继续旧任务时先确认对应分支及其差异。不得覆盖未提交工作或未经授权强制推送。
4. 记录原文件状态（Git diff/提交 SHA），避免覆盖其他人同期的修改。

**实施时：**

5. 仅修改批准的文件或准许的新增工具接入位置。
6. 优先追加局部代码，不整体替换 `index.html` 或 `menu.js`。
7. 修改任何现有文件前先获取最新内容；提交时使用正确的当前 SHA，避免并发覆盖。
8. 禁止顺手改其他工具逻辑；发现无关 Bug 只记录并报告，不自行修复。

**提交后：**

9. 检查 Git diff：**每一个变化都必须能对应本次用户需求**。
10. 确认没有意外修改 `smart-arrange.js`、`smart-arrange.css` 或其他无关文件。
11. 验证 `index.html` 引用的新 CSS 文件实际存在，DOM ID 与 `menu.js`、新 JS 完全对应；`require` 路径正确。
12. 核对全部已有菜单项仍可访问，切换、滚动、输入、预览及原功能没有受到明显影响（能在 Photoshop 测试时应实际测试）。
13. **开发改动只提交测试分支**。不要自行发布 CCX 或更新正式版；用户明确授权的正式发布或文档维护除外。
14. 向用户明确说明：改动文件清单、GitHub 测试分支、测试情况、尚未验证的风险以及如何更新（通常在原测试目录运行 `git pull`）。

## 7. 给后续 AI 的任务模板

用户可以直接复制下面这段给任何 AI：

> 请先完整阅读此仓库根目录的 `AGENTS.md`，严格按照文档的最小修改范围操作。
> 本次任务是：【填写新工具名称、目标功能或需要修复的问题】。
> 只允许新增本工具文件，并修改 `index.html` 和 `menu.js` 中接入本工具的必要位置。
> **不允许修改其他工具的 JS/CSS，尤其是 `smart-arrange.js` 和 `smart-arrange.css`。**
> **不允许修改 `manifest.json` 或 `main` 正式分支**，除非我另外明确授权。
> 修改后请列出所有变更文件，并核对没有影响已有功能。

## 8. 发布规则

- 开发及试错：从最新 `main` 创建独立测试分支，或继续用户指定的同一任务测试分支。
- 用户亲自测试并确认后，才能按其明确指令合并或发布到 `main`。
- 发布前需要再次审查改动范围和差异，不要把其他尚未验收的实验性功能一起发布。
- 若用户没有要求发布正式版，**功能改动永远停留在测试版**。用户明确要求更新正式版文档时，可以仅修改获准的文档。
- 合并前检查测试分支相对最新 `main` 的文件差异、未发布提交与冲突；禁止将无关实验代码带入正式版。
- 合并后检查实际 `main` 文件内容或 Git blob SHA，确认验收功能均已发布。若使用 squash 合并，不能仅凭提交历史分叉判断功能未合并。
- 每次正式发布同步更新 README 的工具数量、功能、文件结构、安装说明及发布记录；若工具清单、接入方式或维护规范变化，同时更新 AGENTS.md。
- 插件版本以 manifest.json 为准，按用户授权的实际打包发布维护版本；不得为文档更新擅自修改版本号。
- 发布完成后，核对测试及诊断分支是否仍含有效未发布代码；确认安全并获用户授权后删除。无法通过当前工具删除时如实说明并保留，不得假称已清理。默认保留 `main`，仅保留尚在开发或有明确用途的测试分支。

---

**维护原则总结：新增功能独立开发、公共文件最小接入、已有功能默认冻结、先测试再发布。**

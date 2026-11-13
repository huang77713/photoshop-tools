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
6. **只在测试分支提交**；除非用户明确要求“更新正式版”，否则不得修改、合并或推送 `main`。
7. 如果必须修改本文件规则所禁止的范围，**先向用户说明原因并获得明确授权**，不要自行扩大范围。

## 1. 项目基本信息

- 仓库：`huang77713/photoshop-tools`
- 技术：Adobe Photoshop UXP Panel，HTML + CSS + JavaScript，使用 `require("photoshop")` 访问 Photoshop API。
- 单面板入口：`manifest.json` 中 `main: "index.html"`。
- 目前正在使用的开发/测试分支：`test/smart-arrange-v1`。
- 生产分支：`main`。**默认只读，不直接改动。**
- 测试分支目前有 **6 个工具**；`main` 可能仍是较早的稳定版，不能根据 `main` 的旧 README 猜测当前测试版结构。
- Windows/Photoshop 开发环境：通过 UXP Developer Tool 加载仓库根目录的 `manifest.json`。

### 当前六个工具和对应代码

| 中文菜单 | 核心逻辑文件 | 样式文件 | HTML 所在位置 |
|---|---|---|---|
| 九宫格拉伸 | `nine-slice.js` | 主要在 `index.html` 中的 `#nineSliceView` 作用域样式 | `index.html` 的 `#nineSliceView` |
| 图片数字排版 | `sprite-font.js` | 主要在 `index.html` 中的 `#spriteFontView` 作用域样式 | `index.html` 的 `#spriteFontView` |
| 透明对象拆分 | `remove-bg.js` | `extra-features.css` | `index.html` 的 `#removeBgView` |
| 文字批量切图 | `text-cutter.js` | `extra-features.css` | `index.html` 的 `#textCutterView` |
| 智能排列 | `smart-arrange.js` | `smart-arrange.css` | `index.html` 的 `#smartArrangeView` |
| 批量尺寸统一 | `visible-resize.js` | `visible-resize.css` | `index.html` 的 `#visibleResizeView` |

**重要：** 上表列出的核心功能文件均为**已有功能保护范围**。新增第七、第八个工具时，不能为了接入新功能而修改它们。

## 2. 新增第七个（或以后任何）工具：允许改哪里？

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
| `main` 分支 | ❌ | ❌ | 必须用户单独批准发布 |
| `AGENTS.md` | ❌ 默认不修改 | ❌ 默认不修改 | 维护规范的更改需用户授权 |

## 4. 六个工具的特殊保护说明

- **智能排列**：`smart-arrange.js` 与 `smart-arrange.css` 含已经迭代过的组复制、嵌套组、对象顺序、间距和预览逻辑。**新增其他工具时，严禁更改这两个文件。**
- **批量尺寸统一**：`visible-resize.js` 的可见像素测量、临时文档流程和独立缩放逻辑与智能排列不同。不要把两套逻辑合并，也不要擅自复用导致两个工具耦合。
- **九宫格拉伸**：原有控件 ID 和预览/分割线/输出区域需要保留。
- **图片数字排版**：原有数字素材读取、排列与输出逻辑需要保留。
- **透明对象拆分**：保留透明背景处理、可见像素识别与导出流程。
- **文字批量切图**：保留文字提取、预览和导出流程。
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

## 6. 每次改动的标准流程（AI 必须遵守）

**开始前：**

1. 先读 `AGENTS.md`，再读用户本次要求涉及的具体文件。
2. 明确本次要动哪些文件，给出最小修改清单。
3. 检查当前 Git 分支，确保是用户指定的测试分支；**默认 `test/smart-arrange-v1`，而不是 `main`**。
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
12. 验证六个已有菜单项仍可访问，切换、滚动、输入、预览及原功能没有受到明显影响（能在 Photoshop 测试时应实际测试）。
13. **只提交测试分支**。不要自行发布 CCX 或更新正式版。
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

- 开发及试错：只在用户指定的测试分支。
- 用户亲自测试并确认后，才能按其明确指令合并或发布到 `main`。
- 发布前需要再次审查改动范围和差异，不要把其他尚未验收的实验性功能一起发布。
- 若用户没有要求发布正式版，**永远停留在测试版**。

---

**维护原则总结：新增功能独立开发、公共文件最小接入、已有功能默认冻结、先测试再发布。**

/* Photoshop Tools: compact startup, original tools load only when selected.
 * No Photoshop API calls, feature DOM, or feature module loading at startup. */
const TOOL_INFO = {
  nineSlicePanel: { label: "九宫格拉伸", icon: "icons/nine-slice.png" },
  spriteFontComposerPanel: { label: "图片数字排版", icon: "icons/sprite-font.png" },
  removeBgPanel: { label: "透明对象拆分", icon: "icons/remove-bg.png" },
  textCutterPanel: { label: "文字批量切图", icon: "icons/text-cutter.png" }
};
const views = Object.create(null);
const initialized = Object.create(null);
let selectedId = "";
let menuOpen = false;
const $ = id => document.getElementById(id);

function toggleMenu(open) {
  menuOpen = !!open;
  $("switchMenu").style.display = menuOpen ? "block" : "none";
  $("switchButton").setAttribute("aria-expanded", String(menuOpen));
}

function showError(message) {
  const notice = $("toolError");
  notice.style.display = "block";
  notice.textContent = message;
}

function getMarkup(id) {
  // UXP CommonJS resolver: imports are literal and used only when requested.
  if (id === "nineSlicePanel") return require("./features-ui/nine-slice.js");
  if (id === "spriteFontComposerPanel") return require("./features-ui/sprite-font.js");
  if (id === "removeBgPanel") return require("./features-ui/remove-bg.js");
  if (id === "textCutterPanel") return require("./features-ui/text-cutter.js");
  throw new Error("未知工具：" + id);
}

function getFeature(id) {
  if (id === "nineSlicePanel") return require("./features/nine-slice.js");
  if (id === "spriteFontComposerPanel") return require("./features/sprite-font.js");
  if (id === "removeBgPanel") return require("./features/remove-bg.js");
  if (id === "textCutterPanel") return require("./features/text-cutter.js");
  throw new Error("未知工具：" + id);
}

function selectTool(id) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_INFO, id)) return;
  toggleMenu(false);
  $("toolError").style.display = "none";
  $("welcome").style.display = "none";
  const container = $("toolContainer");

  Object.keys(views).forEach(key => {
    views[key].style.display = key === id ? "block" : "none";
  });

  $("switchLabel").textContent = TOOL_INFO[id].label;
  $("switchIcon").src = TOOL_INFO[id].icon;
  const items = $("switchMenu").querySelectorAll("[data-tool]");
  for (const item of items) {
    const current = item.getAttribute("data-tool") === id;
    item.classList.toggle("active", current);
    const check = item.querySelector(".check");
    if (check) check.textContent = current ? "✓" : "";
  }
  selectedId = id;
  if (initialized[id]) return;
  try {
    if (!views[id]) {
      const view = document.createElement("div");
      const cls = id === "nineSlicePanel" ? "feature-nine"
        : id === "spriteFontComposerPanel" ? "feature-sprite"
        : id === "removeBgPanel" ? "feature-remove" : "feature-text";
      view.className = "feature " + cls;
      view.style.display = "block";
      // UXP supports innerHTML. Only trusted, bundled markup is inserted.
      view.innerHTML = getMarkup(id);
      container.appendChild(view);
      views[id] = view;
    } else views[id].style.display = "block";
    const mount = getFeature(id);
    if (typeof mount !== "function") throw new Error("功能模块不是函数");
    mount(views[id]);
    initialized[id] = true;
  } catch (error) {
    console.error("[Photoshop Tools] " + id, error);
    showError("功能加载失败：" + (error.message || String(error)));
  }
}

function init() {
  try {
    const button = $("switchButton"), menu = $("switchMenu");
    if (!button || !menu) return;
    button.addEventListener("click", () => toggleMenu(!menuOpen));
    for (const item of menu.querySelectorAll("[data-tool]")) {
      item.addEventListener("click", () => selectTool(item.getAttribute("data-tool")));
    }
    console.log("[Photoshop Tools] lightweight launcher ready");
  } catch (error) {
    console.error("[Photoshop Tools] launcher initialization", error);
    showError("启动菜单初始化失败：" + (error.message || String(error)));
  }
}

/* UXP v5 panel entrypoint must be registered synchronously at plugin startup. */
const { entrypoints } = require("uxp");
let panelCreated = false;
const initialHtml = `
<div id="app">
  <div class="tool-switcher">
    <button id="switchButton" type="button" aria-expanded="false">
      <img id="switchIcon" src="icons/plugin.png" alt="">
      <span id="switchLabel">选择工具</span><span class="arrow">⌄</span>
    </button>
    <div id="switchMenu" class="switch-menu" style="display:none">
      <button type="button" data-tool="nineSlicePanel"><img src="icons/nine-slice.png" alt="">九宫格拉伸<span class="check"></span></button>
      <button type="button" data-tool="spriteFontComposerPanel"><img src="icons/sprite-font.png" alt="">图片数字排版<span class="check"></span></button>
      <button type="button" data-tool="removeBgPanel"><img src="icons/remove-bg.png" alt="">透明对象拆分<span class="check"></span></button>
      <button type="button" data-tool="textCutterPanel"><img src="icons/text-cutter.png" alt="">文字批量切图<span class="check"></span></button>
    </div>
  </div>
  <div id="workspace">
    <div id="welcome">请选择左上角的工具<div class="welcome-sub">一个插件 · 四个功能</div></div>
    <div id="toolError" role="alert" style="display:none"></div>
    <div id="toolContainer"></div>
  </div>
</div>`;

function mountPanel(rootNode) {
  if (panelCreated) return;
  const wrapper = document.createElement("div");
  wrapper.id = "photoshopToolsRoot";
  wrapper.style.cssText = "width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;";
  wrapper.innerHTML = initialHtml;
  rootNode.appendChild(wrapper);
  panelCreated = true;
  init();
}
entrypoints.setup({
  panels: {
    photoshopToolsPanel: {
      create(rootNode) { mountPanel(rootNode); },
      show(rootNode) { mountPanel(rootNode); }
    }
  }
});

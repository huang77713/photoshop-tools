/* One Photoshop UXP plugin, one panel, four independently mounted tools. */
const { entrypoints } = require("uxp");
const definitions = {
  nineSlicePanel: { title: "九宫格拉伸", icon: "icons/nine-slice.png" },
  spriteFontComposerPanel: { title: "图片数字排版", icon: "icons/sprite-font.png" },
  removeBgPanel: { title: "透明对象拆分", icon: "icons/remove-bg.png" },
  textCutterPanel: { title: "文字批量切图", icon: "icons/text-cutter.png" }
};
const loaded = Object.create(null);
let selectedTool = "";
let initialized = false;
let menuOpen = false;

function setMenu(open) {
  menuOpen = !!open;
  const menu = document.getElementById("toolMenu");
  const picker = document.getElementById("toolPicker");
  if (menu) menu.style.display = menuOpen ? "block" : "none";
  if (picker) picker.setAttribute("aria-expanded", String(menuOpen));
}
function selectTool(id) {
  if (!Object.prototype.hasOwnProperty.call(definitions, id)) return;
  const details = definitions[id];
  const views = document.querySelectorAll(".suite-view");
  for (const view of views) {
    view.style.display = view.id === "view-" + id ? "block" : "none";
  }
  document.getElementById("currentToolName").textContent = details.title;
  document.getElementById("currentToolIcon").src = details.icon;
  const options = document.querySelectorAll(".tool-menu-item");
  for (const option of options) {
    const active = option.getAttribute("data-panel") === id;
    option.classList.toggle("is-active", active);
    const check = option.querySelector(".tool-check");
    if (check) check.textContent = active ? "✓" : "";
  }
  selectedTool = id;
  const home = document.getElementById("toolWelcome");
  if (home) home.style.display = "none";
  setMenu(false);
  if (loaded[id]) return;
  // Literal CommonJS imports keep UXP's module resolver deterministic.
  try {
    let module;
    if (id === "nineSlicePanel") module = require("./tools/nine-slice/index.js");
    else if (id === "spriteFontComposerPanel") module = require("./tools/sprite-font/index.js");
    else if (id === "removeBgPanel") module = require("./tools/remove-bg/index.js");
    else module = require("./tools/text-cutter/index.js");
    const root = document.getElementById("view-" + id);
    if (!root || !module || typeof module.mount !== "function") {
      throw new Error("无法加载工具模块：" + id);
    }
    module.mount(root);
    loaded[id] = true;
  } catch (error) {
    console.error("[Photoshop Tools] " + id, error);
    const root = document.getElementById("view-" + id);
    if (root) {
      let warning = root.querySelector(".suite-error");
      if (!warning) {
        warning = document.createElement("div");
        warning.className = "suite-error";
        root.insertBefore(warning, root.firstChild);
      }
      warning.textContent = "工具启动失败：" + (error.message || String(error));
    }
  }
}

function initPanel(rootNode) {
  // In UXP, the visible panel has its own rootNode. The markup in index.html
  // must be attached to that node; otherwise Photoshop can show a blank panel.
  const shell = document.getElementById("suite-shell");
  if (!shell) {
    console.error("[Photoshop Tools] Missing suite-shell in index.html");
    return;
  }
  if (rootNode && rootNode !== shell && shell.parentNode !== rootNode) {
    rootNode.appendChild(shell);
  }
  if (initialized) return;
  const picker = document.getElementById("toolPicker");
  const menu = document.getElementById("toolMenu");
  if (!picker || !menu) return;
  initialized = true;
  picker.addEventListener("click", () => setMenu(!menuOpen));
  const options = menu.querySelectorAll(".tool-menu-item");
  for (const option of options) {
    option.addEventListener("click", () => selectTool(option.getAttribute("data-panel")));
  }
  // Show the first view without executing any Photoshop processing code at launch.
  // It is mounted when the user explicitly chooses it from the dropdown.
  selectedTool = "";
  setMenu(false);
  const views = document.querySelectorAll(".suite-view");
  for (const view of views) view.style.display = "none";
  document.getElementById("currentToolName").textContent = "选择工具";
  document.getElementById("currentToolIcon").src = "icons/plugin.png";
  const home = document.getElementById("toolWelcome");
  if (home) home.style.display = "flex";
}

entrypoints.setup({
  panels: {
    photoshopToolsPanel: {
      create(rootNode) { initPanel(rootNode); },
      show(rootNode) { initPanel(rootNode); }
    }
  }
});

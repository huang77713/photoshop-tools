/* Photoshop Tools: one panel, four isolated tool views.
   Avoid dynamic HTML template APIs and initialize one tool on demand. */
const { entrypoints } = require("uxp");

const toolFiles = {
  nineSlicePanel: "./tools/nine-slice/index.js",
  spriteFontComposerPanel: "./tools/sprite-font/index.js",
  removeBgPanel: "./tools/remove-bg/index.js",
  textCutterPanel: "./tools/text-cutter/index.js"
};
const instances = {};
let activeId = null;
let navigationReady = false;

function showTool(id) {
  if (!Object.prototype.hasOwnProperty.call(toolFiles, id)) return;
  if (id === activeId) return;

  // First make the target visible, so the existing tool can measure its UI.
  const views = document.querySelectorAll(".suite-view");
  for (const view of views) {
    view.style.display = view.id === "view-" + id ? "block" : "none";
  }
  const tabs = document.querySelectorAll(".suite-tab");
  for (const tab of tabs) {
    const isActive = tab.getAttribute("data-panel") === id;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  }
  activeId = id;
  if (!instances[id]) {
    // Lazy loading prevents the other three tools from running during startup.
    try {
      const tool = id === "nineSlicePanel" ? require("./tools/nine-slice/index.js")
        : id === "spriteFontComposerPanel" ? require("./tools/sprite-font/index.js")
        : id === "removeBgPanel" ? require("./tools/remove-bg/index.js")
        : require("./tools/text-cutter/index.js");
      const root = document.getElementById("view-" + id);
      if (!root || !tool || typeof tool.mount !== "function") {
        throw new Error("Missing tool container or mount function: " + id);
      }
      tool.mount(root);
      instances[id] = true;
    } catch (err) {
      console.error("[Photoshop Tools] Mount failed: " + id, err);
      const root = document.getElementById("view-" + id);
      if (root) {
        const warning = document.createElement("div");
        warning.className = "suite-error";
        warning.textContent = "工具启动失败：" + (err.message || String(err));
        root.appendChild(warning);
      }
    }
  }
}

function initialize() {
  if (navigationReady) return;
  navigationReady = true;
  const tabs = document.querySelectorAll(".suite-tab");
  for (const tab of tabs) {
    tab.addEventListener("click", () => showTool(tab.getAttribute("data-panel")));
  }
  showTool("nineSlicePanel");
}

entrypoints.setup({
  panels: {
    photoshopToolsPanel: {
      show() { initialize(); }
    }
  }
});

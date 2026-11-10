const { entrypoints } = require("uxp");

// Only one Photoshop panel is installed. Each existing tool is mounted in its
// own DOM subtree, and initialized only when opened for the first time.
const modules = {
  nineSlicePanel: require("./tools/nine-slice/index.js"),
  spriteFontComposerPanel: require("./tools/sprite-font/index.js"),
  removeBgPanel: require("./tools/remove-bg/index.js"),
  textCutterPanel: require("./tools/text-cutter/index.js")
};

const tools = [
  { id: "nineSlicePanel", name: "九宫格拉伸", icon: "icons/nine-slice.png" },
  { id: "spriteFontComposerPanel", name: "图片数字排版", icon: "icons/sprite-font.png" },
  { id: "removeBgPanel", name: "透明对象拆分", icon: "icons/remove-bg.png" },
  { id: "textCutterPanel", name: "文字批量切图", icon: "icons/text-cutter.png" }
];

const instances = new WeakMap();

function createSuite(rootNode) {
  const shell = document.createElement("div");
  shell.className = "suite-shell";
  const top = document.createElement("div");
  top.className = "suite-top";
  const heading = document.createElement("div");
  heading.className = "suite-heading";
  heading.textContent = "Photoshop Tools";
  top.appendChild(heading);
  const nav = document.createElement("div");
  nav.className = "suite-nav";
  nav.setAttribute("role", "tablist");
  top.appendChild(nav);
  const body = document.createElement("div");
  body.className = "suite-body";
  shell.appendChild(top);
  shell.appendChild(body);
  rootNode.appendChild(shell);

  const views = new Map();
  const buttons = new Map();
  let selected = null;

  function activate(id) {
    if (selected === id) return;
    for (const item of tools) {
      const button = buttons.get(item.id);
      button.classList.toggle("is-active", item.id === id);
      button.setAttribute("aria-selected", String(item.id === id));
      const existing = views.get(item.id);
      if (existing) existing.style.display = item.id === id ? "block" : "none";
    }
    if (!views.has(id)) {
      const template = document.getElementById("tpl-" + id);
      if (!template) throw new Error("Missing tool template: " + id);
      const view = document.createElement("div");
      view.className = "suite-view";
      view.setAttribute("role", "tabpanel");
      view.appendChild(template.content.cloneNode(true));
      body.appendChild(view);
      views.set(id, view);
      try {
        modules[id].mount(view);
      } catch (e) {
        console.error("Tool failed to initialize: " + id, e);
        const warning = document.createElement("div");
        warning.className = "suite-error";
        warning.textContent = "工具初始化失败：" + (e.message || String(e));
        view.appendChild(warning);
      }
    } else {
      views.get(id).style.display = "block";
    }
    selected = id;
  }

  for (const item of tools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suite-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    const icon = document.createElement("img");
    icon.src = item.icon;
    icon.alt = "";
    const label = document.createElement("span");
    label.textContent = item.name;
    button.appendChild(icon);
    button.appendChild(label);
    button.addEventListener("click", () => activate(item.id));
    nav.appendChild(button);
    buttons.set(item.id, button);
  }
  activate("nineSlicePanel");
  return { shell, activate };
}

entrypoints.setup({
  panels: {
    photoshopToolsPanel: {
      show(rootNode) {
        if (!rootNode) return;
        if (!instances.has(rootNode)) instances.set(rootNode, createSuite(rootNode));
      }
    }
  }
});

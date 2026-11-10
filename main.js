/* Simple UXP panel controller. All Photoshop functions are isolated in /features. */
const tools = {
  nineSlicePanel: {label:"九宫格拉伸",icon:"icons/nine-slice.png"},
  spriteFontComposerPanel: {label:"图片数字排版",icon:"icons/sprite-font.png"},
  removeBgPanel: {label:"透明对象拆分",icon:"icons/remove-bg.png"},
  textCutterPanel: {label:"文字批量切图",icon:"icons/text-cutter.png"}
};
const initialized = Object.create(null);
let active = null;
let menuOpen = false;
let ready = false;
const byId = id => document.getElementById(id);

function setMenu(open) {
  menuOpen = !!open;
  byId("switchMenu").style.display = menuOpen ? "block" : "none";
  byId("switchButton").setAttribute("aria-expanded", menuOpen ? "true" : "false");
}

function openTool(key) {
  if (!Object.prototype.hasOwnProperty.call(tools, key)) return;
  setMenu(false);
  byId("welcome").style.display = "none";
  for (const id of Object.keys(tools)) {
    byId("view-" + id).style.display = id === key ? "block" : "none";
  }
  byId("switchLabel").textContent = tools[key].label;
  byId("switchIcon").src = tools[key].icon;
  const items = byId("switchMenu").querySelectorAll("[data-tool]");
  for (const item of items) {
    const selected = item.getAttribute("data-tool") === key;
    item.classList.toggle("active", selected);
    item.querySelector(".check").textContent = selected ? "✓" : "";
  }
  active = key;
  if (initialized[key]) return;
  try {
    // No Photoshop code is executed until its tool is chosen.
    let mount;
    if (key === "nineSlicePanel") mount = require("./features/nine-slice.js");
    else if (key === "spriteFontComposerPanel") mount = require("./features/sprite-font.js");
    else if (key === "removeBgPanel") mount = require("./features/remove-bg.js");
    else mount = require("./features/text-cutter.js");
    if (typeof mount !== "function") throw new Error("功能模块未正确导出");
    mount(byId("view-" + key));
    initialized[key] = true;
  } catch (error) {
    console.error("[Photoshop Tools] "+key,error);
    const view = byId("view-" + key);
    let message = view.querySelector(".feature-error");
    if (!message) {
      message = document.createElement("div");
      message.className = "feature-error";
      message.style.cssText = "padding:10px;color:#ffb0a8;background:#392b2b;border:1px solid #8d5353;";
      view.insertBefore(message, view.firstChild);
    }
    message.textContent = "加载失败：" + (error.message || String(error));
  }
}

function init() {
  if (ready) return;
  const button = byId("switchButton");
  const menu = byId("switchMenu");
  if (!button || !menu) return;
  ready = true;
  button.addEventListener("click", () => setMenu(!menuOpen));
  for (const item of menu.querySelectorAll("[data-tool]")) {
    item.addEventListener("click", () => openTool(item.getAttribute("data-tool")));
  }
  setMenu(false);
  // Startup is intentionally UI-only, to minimize host crash risk.
}
if (document.readyState === "loading") window.addEventListener("load", init);
else init();

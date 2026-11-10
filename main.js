const { entrypoints } = require("uxp");

const modules = {
  nineSlicePanel: require("./tools/nine-slice/index.js"),
  spriteFontComposerPanel: require("./tools/sprite-font/index.js"),
  removeBgPanel: require("./tools/remove-bg/index.js"),
  textCutterPanel: require("./tools/text-cutter/index.js")
};

const mounted = new WeakSet();

function showPanel(panelId, rootNode) {
  if (!rootNode) return;
  if (!mounted.has(rootNode)) {
    const template = document.getElementById("tpl-" + panelId);
    if (!template) throw new Error("Missing template for " + panelId);
    const content = template.content.cloneNode(true);
    rootNode.appendChild(content);
    modules[panelId].mount(rootNode);
    mounted.add(rootNode);
  }
}

entrypoints.setup({
  panels: {
    nineSlicePanel: {
      show(rootNode) { showPanel("nineSlicePanel", rootNode); }
    },
    spriteFontComposerPanel: {
      show(rootNode) { showPanel("spriteFontComposerPanel", rootNode); }
    },
    removeBgPanel: {
      show(rootNode) { showPanel("removeBgPanel", rootNode); }
    },
    textCutterPanel: {
      show(rootNode) { showPanel("textCutterPanel", rootNode); }
    }
  }
});

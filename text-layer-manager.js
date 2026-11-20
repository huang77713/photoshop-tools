/* Text Layer Manager - Photoshop UXP */
module.exports = function initTextLayerManager(root) {
  "use strict";
  const photoshop = require("photoshop");
  const app = photoshop.app;
  const core = photoshop.core;
  const action = photoshop.action;
  const constants = photoshop.constants;

  const $ = id => root.querySelector("#" + id);
  const status = $("tlmStatus");

  function setStatus(message, type) {
    status.textContent = message;
    status.className = "tlm-status" + (type ? " " + type : "");
  }

  function isText(layer) {
    if (!layer) return false;
    const kind = String(layer.kind || "").toLowerCase();
    return layer.kind === constants.LayerKind.TEXT ||
      kind === "text" || kind === "layerkind.text" || kind === "3";
  }

  function isGroup(layer) {
    return !!layer && layer.layers && typeof layer.layers.length === "number";
  }

  function walk(layers, out) {
    out = out || [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      out.push(layer);
      if (isGroup(layer)) walk(layer.layers, out);
    }
    return out;
  }

  function descendantsOf(layers) {
    const out = [];
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      out.push(layer);
      if (isGroup(layer)) walk(layer.layers, out);
    }
    return out;
  }

  function getDocument() {
    if (!app.activeDocument) throw new Error("请先打开一个 Photoshop 文档。");
    return app.activeDocument;
  }

  function getScopeLayers(scope) {
    const doc = getDocument();
    if (scope === "all") return walk(doc.layers, []);
    return descendantsOf(Array.from(doc.activeLayers || []));
  }

  function uniqueLayers(layers) {
    const seen = {};
    return layers.filter(layer => {
      const id = String(layer.id);
      if (seen[id]) return false;
      seen[id] = true;
      return true;
    });
  }

  async function selectLayers(layers) {
    if (!layers.length) throw new Error("没有找到符合条件的图层。");
    const ids = layers.map(layer => Number(layer.id)).filter(Number.isFinite);
    if (!ids.length) throw new Error("无法读取目标图层 ID。");
    const originalIds = (app.activeDocument.activeLayers || []).map(layer => Number(layer.id));
    await core.executeAsModal(async () => {
      try {
        // Send one selection action per layer. This avoids multi-command
        // selection state races in Photoshop UXP batchPlay.
        for (let i = 0; i < ids.length; i++) {
          const command = {
            _obj: "select",
            _target: [{ _ref: "layer", _id: ids[i] }],
            makeVisible: false
          };
          if (i > 0) {
            command.selectionModifier = {
              _enum: "selectionModifierType",
              _value: "addToSelection"
            };
          }
          await action.batchPlay([command], { synchronousExecution: true });
        }
        const selectedIds = new Set((app.activeDocument.activeLayers || []).map(layer => Number(layer.id)));
        const missing = ids.filter(id => !selectedIds.has(id));
        if (missing.length || selectedIds.size !== ids.length) {
          throw new Error("选中结果不一致：目标 " + ids.length + " 个，实际 " +
            selectedIds.size + " 个；请检查锁定图层或 Photoshop 选择状态。");
        }
      } catch (error) {
        // Best-effort restoration of the previous selection.
        if (originalIds.length) {
          try {
            for (let i = 0; i < originalIds.length; i++) {
              const command = { _obj: "select",
                _target: [{ _ref: "layer", _id: originalIds[i] }],
                makeVisible: false };
              if (i) command.selectionModifier = {
                _enum: "selectionModifierType", _value: "addToSelection"
              };
              await action.batchPlay([command], { synchronousExecution: true });
            }
          } catch (restoreError) {
            console.warn("[Text Layer Manager] Restore selection failed:", restoreError);
          }
        }
        throw error;
      }
    }, { commandName: "筛选文字图层" });
  }

  $("tlmFilterRun").addEventListener("click", async function () {
    try {
      setStatus("正在筛选…");
      const scope = $("tlmScope").value;
      const type = $("tlmLayerType").value;
      let layers = uniqueLayers(getScopeLayers(scope));
      if (type === "text") layers = layers.filter(isText);
      else if (type === "group") layers = layers.filter(isGroup);
      else if (type === "textAndGroup") layers = layers.filter(layer => isText(layer) || isGroup(layer));
      await selectLayers(layers);
      setStatus("已选中 " + layers.length + " 个符合条件的图层。", "ok");
    } catch (error) {
      console.error("[Text Layer Manager] Filter failed:", error);
      setStatus(String(error && error.message || error), "error");
    }
  });

  async function translateText(text, target) {
    const value = String(text || "");
    if (!value.trim()) return value;
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=" +
      encodeURIComponent(target) + "&dt=t&q=" + encodeURIComponent(value);
    const response = await fetch(url);
    if (!response.ok) throw new Error("翻译服务请求失败：" + response.status);
    const data = await response.json();
    if (!data || !data[0]) throw new Error("翻译服务没有返回结果。");
    let result = "";
    for (let i = 0; i < data[0].length; i++) {
      if (data[0][i] && data[0][i][0]) result += data[0][i][0];
    }
    return result || value;
  }

  $("tlmTranslate").addEventListener("click", async function () {
    try {
      const doc = getDocument();
      const active = Array.from(doc.activeLayers || []);
      if (!active.length) throw new Error("请先在 Photoshop 中选择图层。");

      const doNames = $("tlmTranslateNames").checked;
      const doText = $("tlmTranslateText").checked;
      const doGroups = $("tlmTranslateGroups").checked;
      if (!doNames && !doText && !doGroups) throw new Error("请至少勾选一个翻译项目。");

      const target = $("tlmTargetLang").value;
      const candidates = uniqueLayers(descendantsOf(active));
      const tasks = [];
      for (let i = 0; i < candidates.length; i++) {
        const layer = candidates[i];
        if (doText && isText(layer)) {
          tasks.push({ layer, field: "text", original: layer.textItem.contents });
        }
        if (doGroups && isGroup(layer)) {
          tasks.push({ layer, field: "name", original: layer.name });
        } else if (doNames && !isGroup(layer)) {
          tasks.push({ layer, field: "name", original: layer.name });
        }
      }
      if (!tasks.length) throw new Error("当前选择中没有可翻译的内容。");

      setStatus("正在翻译 " + tasks.length + " 项…");
      const results = [];
      for (let i = 0; i < tasks.length; i++) {
        results.push(await translateText(tasks[i].original, target));
      }

      await core.executeAsModal(async () => {
        for (let i = 0; i < tasks.length; i++) {
          if (tasks[i].field === "text") tasks[i].layer.textItem.contents = results[i];
          else tasks[i].layer.name = results[i];
        }
      }, { commandName: "翻译文字图层" });

      setStatus("翻译完成，共处理 " + tasks.length + " 项。", "ok");
    } catch (error) {
      console.error("[Text Layer Manager] Translate failed:", error);
      setStatus(String(error && error.message || error), "error");
    }
  });

  $("tlmReplace").addEventListener("click", async function () {
    try {
      const value = $("tlmReplaceText").value;
      if (!value.length) throw new Error("请输入要替换成的文字内容。");
      const doc = getDocument();
      const selected = uniqueLayers(Array.from(doc.activeLayers || []).filter(isText));
      if (!selected.length) throw new Error("请先选中至少一个文字图层。");

      await core.executeAsModal(async () => {
        for (let i = 0; i < selected.length; i++) {
          selected[i].textItem.contents = value;
        }
      }, { commandName: "批量修改文字内容" });

      setStatus("已将 " + selected.length + " 个文字图层统一修改为：“" + value + "”。", "ok");
    } catch (error) {
      console.error("[Text Layer Manager] Replace failed:", error);
      setStatus(String(error && error.message || error), "error");
    }
  });

  root.__textLayerManagerActivate = function () {
    try {
      const doc = app.activeDocument;
      const count = doc && doc.activeLayers ? doc.activeLayers.length : 0;
      setStatus(count ? "当前已选择 " + count + " 个图层。" : "请选择图层后进行操作。");
    } catch (_) {
      setStatus("请选择图层后进行操作。");
    }
  };
  root.__textLayerManagerActivate();
};
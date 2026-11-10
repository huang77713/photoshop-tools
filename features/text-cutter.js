/* Original Photoshop processing logic retained; only DOM scope and entrypoint changed. */
module.exports = function mount(root) {
const { app, core, constants } = require("photoshop");
const { storage } = require("uxp");

const fs = storage.localFileSystem;

const STORAGE = {
  text: "textCutter.v110.text",
  tracking: "textCutter.v110.tracking",
  padding: "textCutter.v110.padding",
  outputName: "textCutter.v110.outputName",
  keepWorkDoc: "textCutter.v110.keepWorkDoc",
  folderToken: "textCutter.folderToken"
};

let outputFolder = null;

function $(id) {
  return root.querySelector("#" + id);
}

function setMessage(text, type = "muted") {
  const el = $("message");
  el.textContent = text;
  el.className = `message ${type}`;
}

function formatError(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch (_) {}
  try {
    return String(err);
  } catch (_) {
    return "未知错误";
  }
}

function safeName(value) {
  const v = String(value || "").trim();
  return v || "output";
}

function safeFileName(value) {
  return safeName(value)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+$/, "output");
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.value === "number") return value.value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getBounds(layer) {
  const b = layer.bounds;
  return {
    left: toNumber(b.left),
    top: toNumber(b.top),
    right: toNumber(b.right),
    bottom: toNumber(b.bottom)
  };
}

function boundsWidth(b) {
  return Math.max(0, b.right - b.left);
}

function boundsHeight(b) {
  return Math.max(0, b.bottom - b.top);
}

function getLayerText(layer) {
  try {
    return String(layer.textItem.contents || "");
  } catch (_) {
    return "";
  }
}

function flattenLayers(layers, out = []) {
  if (!layers) return out;
  for (const layer of Array.from(layers)) {
    out.push(layer);
    try {
      if (layer.layers && layer.layers.length) {
        flattenLayers(layer.layers, out);
      }
    } catch (_) {}
  }
  return out;
}

function getCurrentTextLayer() {
  if (!app.documents || app.documents.length === 0) {
    throw new Error("请先打开一个 PSD/PSB 文档。");
  }

  const doc = app.activeDocument;
  const selected = doc.activeLayers;

  if (!selected || selected.length !== 1) {
    throw new Error("请只选中一个文字图层。");
  }

  const layer = selected[0];
  if (layer.kind !== constants.LayerKind.TEXT) {
    throw new Error("当前选中的不是文字图层。");
  }

  return { doc, layer };
}

function findTemplateInDuplicatedDocument(workDoc, snapshot) {
  const selected = workDoc.activeLayers || [];
  if (selected.length === 1 && selected[0].kind === constants.LayerKind.TEXT) {
    const candidate = selected[0];
    if (getLayerText(candidate) === snapshot.contents || candidate.name === snapshot.name) {
      return candidate;
    }
  }

  const textLayers = flattenLayers(workDoc.layers || []).filter(
    (layer) => layer.kind === constants.LayerKind.TEXT
  );

  let matches = textLayers.filter(
    (layer) => layer.name === snapshot.name && getLayerText(layer) === snapshot.contents
  );
  if (matches.length === 1) return matches[0];

  matches = textLayers.filter((layer) => getLayerText(layer) === snapshot.contents);
  if (matches.length === 1) return matches[0];

  matches = textLayers.filter((layer) => layer.name === snapshot.name);
  if (matches.length === 1) return matches[0];

  throw new Error("临时工作副本里无法唯一定位刚才选中的模板文字层。");
}

function findCleanTextLayer(cleanDoc, expectedText, preferredId = null) {
  const textLayers = flattenLayers(cleanDoc.layers || []).filter(
    (layer) => layer.kind === constants.LayerKind.TEXT
  );

  if (preferredId !== null) {
    const byId = textLayers.find((layer) => layer.id === preferredId);
    if (byId) return byId;
  }

  const byText = textLayers.filter((layer) => getLayerText(layer) === expectedText);
  if (byText.length === 1) return byText[0];

  if (textLayers.length === 1) return textLayers[0];

  throw new Error("干净文档里无法唯一定位目标文字层。");
}

function refreshLayerStatus() {
  try {
    const { layer } = getCurrentTextLayer();
    let preview = getLayerText(layer);
    let textType = "";

    try {
      textType = layer.textItem.isParagraphText ? "段落文字" : "点文字";
    } catch (_) {}

    if (preview.length > 28) preview = preview.slice(0, 28) + "…";
    $("layerStatus").textContent = `✓ ${layer.name}${preview ? ` · ${preview}` : ""}${textType ? ` · ${textType}` : ""}`;
    $("layerStatus").className = "status success";
    return true;
  } catch (err) {
    $("layerStatus").textContent = formatError(err);
    $("layerStatus").className = "status error";
    return false;
  }
}

async function chooseFolder() {
  try {
    const folder = await fs.getFolder();
    if (!folder) return;

    outputFolder = folder;
    const token = await fs.createPersistentToken(folder);
    localStorage.setItem(STORAGE.folderToken, token);

    $("folderPath").textContent = fs.getNativePath(folder) || folder.name;
    $("folderPath").className = "folder-path";
    setMessage("保存路径已选择", "success");
  } catch (err) {
    setMessage(`选择文件夹失败：${formatError(err)}`, "error");
  }
}

async function restoreFolder() {
  const token = localStorage.getItem(STORAGE.folderToken);
  if (!token) return;

  try {
    const entry = await fs.getEntryForPersistentToken(token);
    if (entry && entry.isFolder) {
      outputFolder = entry;
      $("folderPath").textContent = fs.getNativePath(entry) || entry.name;
      $("folderPath").className = "folder-path";
    }
  } catch (_) {
    localStorage.removeItem(STORAGE.folderToken);
    outputFolder = null;
  }
}

function restoreSettings() {
  const text = localStorage.getItem(STORAGE.text);
  const tracking = localStorage.getItem(STORAGE.tracking);
  const padding = localStorage.getItem(STORAGE.padding);
  const outputName = localStorage.getItem(STORAGE.outputName);
  const keepWorkDoc = localStorage.getItem(STORAGE.keepWorkDoc);

  if (text !== null) $("characters").value = text;
  if (tracking !== null) $("tracking").value = tracking;
  if (padding !== null) $("padding").value = padding;
  if (outputName !== null) $("outputName").value = outputName;
  if (keepWorkDoc !== null) $("keepWorkDoc").checked = keepWorkDoc === "true";
}

function saveSettings() {
  localStorage.setItem(STORAGE.text, $("characters").value);
  localStorage.setItem(STORAGE.tracking, $("tracking").value);
  localStorage.setItem(STORAGE.padding, $("padding").value);
  localStorage.setItem(STORAGE.outputName, $("outputName").value);
  localStorage.setItem(STORAGE.keepWorkDoc, String($("keepWorkDoc").checked));
}

function readSettings() {
  const text = String($("characters").value || "")
    .replace(/\r/g, "")
    .replace(/\n/g, "");
  const tracking = Number($("tracking").value);
  const padding = Number($("padding").value);
  const outputName = safeName($("outputName").value);
  const keepWorkDoc = $("keepWorkDoc").checked;

  if (text.replace(/[\t ]/g, "").length === 0) {
    throw new Error("文字内容不能为空。");
  }
  if (!Number.isFinite(tracking) || tracking < -1000 || tracking > 1000) {
    throw new Error("Tracking 请输入 -1000 到 1000 之间的数值。");
  }
  if (!Number.isFinite(padding) || padding < 0 || padding > 2000) {
    throw new Error("Padding 请输入 0 到 2000 之间的数值。");
  }
  if (!outputFolder) {
    throw new Error("请先选择 PNG 保存文件夹。");
  }

  return {
    text,
    tracking,
    padding: Math.round(padding),
    outputName,
    keepWorkDoc
  };
}

async function createOutputFile(name) {
  const fileName = `${safeFileName(name)}.png`;
  const file = await outputFolder.createFile(fileName, { overwrite: true });
  return { file, fileName };
}

async function updateTextLayer(textLayer, settings) {
  try { textLayer.visible = true; } catch (_) {}
  try { textLayer.allLocked = false; } catch (_) {}
  try { textLayer.positionLocked = false; } catch (_) {}

  let textItem = textLayer.textItem;
  if (textItem.isParagraphText) {
    await textItem.convertToPointText();
    textItem = textLayer.textItem;
  }

  if (!textItem || textItem.isParagraphText) {
    throw new Error("无法把模板转换成点文字。");
  }

  textItem.contents = settings.text;
  textItem = textLayer.textItem;
  textItem.characterStyle.tracking = settings.tracking;

  await new Promise((resolve) => setTimeout(resolve, 80));

  const actual = getLayerText(textLayer);
  if (actual !== settings.text) {
    throw new Error(`文字替换没有生效：当前内容是“${actual}”`);
  }
}

async function ensureLayerFitsDocument(doc, layer, padding) {
  app.activeDocument = doc;

  let b = getBounds(layer);
  if (boundsWidth(b) <= 0 || boundsHeight(b) <= 0) {
    throw new Error("文字替换后没有得到有效图层边界。");
  }

  const margin = Math.max(80, padding);
  const dx = b.left < margin ? margin - b.left : 0;
  const dy = b.top < margin ? margin - b.top : 0;

  if (dx || dy) {
    await layer.translate(dx, dy);
    b = getBounds(layer);
  }

  const targetWidth = Math.ceil(Math.max(toNumber(doc.width), b.right + margin));
  const targetHeight = Math.ceil(Math.max(toNumber(doc.height), b.bottom + margin));

  if (targetWidth > toNumber(doc.width) || targetHeight > toNumber(doc.height)) {
    await doc.resizeCanvas(targetWidth, targetHeight, constants.AnchorPosition.TOPLEFT);
  }
}

function isTopLevelLayer(doc, layer) {
  try {
    return Array.from(doc.layers || []).some((item) => item.id === layer.id);
  } catch (_) {
    return false;
  }
}

async function promoteLayerToCleanRoot(cleanDoc, layer, initialLayerIds) {
  app.activeDocument = cleanDoc;
  if (isTopLevelLayer(cleanDoc, layer)) return layer;

  const currentTop = Array.from(cleanDoc.layers || []);
  let anchor = currentTop.find((item) => initialLayerIds.has(item.id));
  if (!anchor && currentTop.length) anchor = currentTop[0];

  if (!anchor) {
    throw new Error("干净文档里没有可用的顶层锚点，无法整理目标文字层。");
  }

  await layer.move(anchor, constants.ElementPlacement.PLACEBEFORE);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const refreshed = findCleanTextLayer(cleanDoc, getLayerText(layer), layer.id);
  if (!isTopLevelLayer(cleanDoc, refreshed)) {
    throw new Error("目标文字层无法移动到干净文档顶层。");
  }

  return refreshed;
}

async function removeOnlyAutoBlankLayers(cleanDoc, initialLayerIds, keepLayer) {
  app.activeDocument = cleanDoc;

  const topLayers = Array.from(cleanDoc.layers || []);
  for (const layer of topLayers) {
    if (layer.id === keepLayer.id) continue;
    if (!initialLayerIds.has(layer.id)) continue;

    try {
      await layer.delete();
    } catch (err) {
      throw new Error(`删除自动空白层“${layer.name}”失败：${formatError(err)}`);
    }
  }

  const allLayers = flattenLayers(cleanDoc.layers || []);
  const textLayers = allLayers.filter((layer) => layer.kind === constants.LayerKind.TEXT);
  if (textLayers.length !== 1 || textLayers[0].id !== keepLayer.id) {
    throw new Error("干净文档里不是唯一目标文字层。");
  }
}

async function extractTargetLayer(tempDoc, tempLayer, cleanDoc, settings, initialLayerIds) {
  app.activeDocument = tempDoc;

  let copied = null;
  let directError = null;

  try {
    copied = await tempLayer.duplicate(
      cleanDoc,
      constants.ElementPlacement.PLACEATBEGINNING,
      settings.outputName
    );
  } catch (err) {
    directError = err;
  }

  if (!copied) {
    try {
      const copies = await tempDoc.duplicateLayers([tempLayer], cleanDoc);
      if (copies && copies.length === 1) copied = copies[0];
    } catch (fallbackErr) {
      const first = directError ? formatError(directError) : "无";
      throw new Error(`复制目标文字层失败。Layer.duplicate：${first}；duplicateLayers：${formatError(fallbackErr)}`);
    }
  }

  if (!copied) {
    throw new Error("复制目标文字层到干净文档失败。");
  }

  app.activeDocument = cleanDoc;
  await new Promise((resolve) => setTimeout(resolve, 100));

  let cleanLayer = findCleanTextLayer(cleanDoc, settings.text, copied.id);
  if (cleanLayer.kind !== constants.LayerKind.TEXT) {
    throw new Error("复制后的目标不是文字图层。");
  }
  if (getLayerText(cleanLayer) !== settings.text) {
    throw new Error(`复制后的文字内容不正确：当前是“${getLayerText(cleanLayer)}”`);
  }

  cleanLayer = await promoteLayerToCleanRoot(cleanDoc, cleanLayer, initialLayerIds);
  cleanLayer.name = settings.outputName;
  try { cleanLayer.visible = true; } catch (_) {}

  return cleanLayer;
}

async function cropCleanDocToLayer(cleanDoc, layer, padding) {
  app.activeDocument = cleanDoc;

  let b = getBounds(layer);
  if (boundsWidth(b) <= 0 || boundsHeight(b) <= 0) {
    throw new Error("干净文档中的目标文字没有有效边界。");
  }

  const margin = Math.max(20, padding);
  const dx = b.left < margin ? margin - b.left : 0;
  const dy = b.top < margin ? margin - b.top : 0;

  if (dx || dy) {
    await layer.translate(dx, dy);
    b = getBounds(layer);
  }

  const requiredWidth = Math.ceil(Math.max(toNumber(cleanDoc.width), b.right + margin));
  const requiredHeight = Math.ceil(Math.max(toNumber(cleanDoc.height), b.bottom + margin));

  if (requiredWidth > toNumber(cleanDoc.width) || requiredHeight > toNumber(cleanDoc.height)) {
    await cleanDoc.resizeCanvas(requiredWidth, requiredHeight, constants.AnchorPosition.TOPLEFT);
  }

  b = getBounds(layer);
  const cropBounds = {
    left: Math.max(0, Math.floor(b.left - padding)),
    top: Math.max(0, Math.floor(b.top - padding)),
    right: Math.min(toNumber(cleanDoc.width), Math.ceil(b.right + padding)),
    bottom: Math.min(toNumber(cleanDoc.height), Math.ceil(b.bottom + padding))
  };

  if (cropBounds.right <= cropBounds.left || cropBounds.bottom <= cropBounds.top) {
    throw new Error("计算最终裁切范围失败。");
  }

  await cleanDoc.crop(cropBounds);
}

async function closeWithoutSaving(doc) {
  if (!doc) return;
  try {
    app.activeDocument = doc;
    if (typeof doc.closeWithoutSaving === "function") {
      doc.closeWithoutSaving();
    } else {
      await doc.close(constants.SaveOptions.DONOTSAVECHANGES);
    }
  } catch (_) {}
}

async function cleanupFailedDocs(tempDoc, cleanDoc, sourceDoc) {
  try {
    await core.executeAsModal(async () => {
      if (cleanDoc) await closeWithoutSaving(cleanDoc);
      if (tempDoc) await closeWithoutSaving(tempDoc);
      try {
        if (sourceDoc) app.activeDocument = sourceDoc;
      } catch (_) {}
    }, { commandName: "清理失败的文字切图文档" });
  } catch (_) {}
}

async function generateAndExport() {
  const button = $("runBtn");
  button.disabled = true;

  let sourceDoc = null;
  let sourceLayer = null;
  let tempDoc = null;
  let cleanDoc = null;
  let cleanLayer = null;
  let outputFileName = "";
  let stage = "读取设置";

  try {
    const settings = readSettings();
    saveSettings();

    stage = "读取模板图层";
    const source = getCurrentTextLayer();
    sourceDoc = source.doc;
    sourceLayer = source.layer;

    const sourceSnapshot = {
      docId: sourceDoc.id,
      layerId: sourceLayer.id,
      name: sourceLayer.name,
      contents: getLayerText(sourceLayer)
    };

    setMessage("正在生成干净文字文档…", "muted");

    await core.executeAsModal(async (executionContext) => {
      stage = "复制临时工作副本";
      executionContext.reportProgress({ value: 0.08, commandName: stage });

      app.activeDocument = sourceDoc;
      tempDoc = await sourceDoc.duplicate(`__TEXTCUTTER_TEMP__${settings.outputName}`, false);
      if (!tempDoc || tempDoc.id === sourceSnapshot.docId) {
        throw new Error("临时工作副本复制失败。");
      }

      app.activeDocument = tempDoc;

      stage = "定位临时模板文字层";
      executionContext.reportProgress({ value: 0.18, commandName: stage });
      const tempLayer = findTemplateInDuplicatedDocument(tempDoc, sourceSnapshot);

      stage = "修改文字和 Tracking";
      executionContext.reportProgress({ value: 0.30, commandName: stage });
      await updateTextLayer(tempLayer, settings);

      stage = "扩展临时画布";
      executionContext.reportProgress({ value: 0.40, commandName: stage });
      await ensureLayerFitsDocument(tempDoc, tempLayer, settings.padding);

      stage = "新建干净透明文档";
      executionContext.reportProgress({ value: 0.50, commandName: stage });
      cleanDoc = await app.documents.add({
        name: settings.outputName,
        width: Math.max(1, Math.ceil(toNumber(tempDoc.width))),
        height: Math.max(1, Math.ceil(toNumber(tempDoc.height))),
        resolution: tempDoc.resolution,
        mode: "RGBColorMode",
        fill: "transparent"
      });

      const initialLayerIds = new Set(
        Array.from(cleanDoc.layers || []).map((layer) => layer.id)
      );

      stage = "只抽取目标文字层";
      executionContext.reportProgress({ value: 0.62, commandName: stage });
      cleanLayer = await extractTargetLayer(
        tempDoc,
        tempLayer,
        cleanDoc,
        settings,
        initialLayerIds
      );

      stage = "删除干净文档自动空白层";
      executionContext.reportProgress({ value: 0.72, commandName: stage });
      await removeOnlyAutoBlankLayers(cleanDoc, initialLayerIds, cleanLayer);

      stage = "关闭临时工作副本";
      executionContext.reportProgress({ value: 0.78, commandName: stage });
      await closeWithoutSaving(tempDoc);
      tempDoc = null;

      stage = "按目标文字真实边界裁切";
      executionContext.reportProgress({ value: 0.82, commandName: stage });
      await cropCleanDocToLayer(cleanDoc, cleanLayer, settings.padding);

      const finalTopLayers = Array.from(cleanDoc.layers || []);
      if (finalTopLayers.length !== 1 || finalTopLayers[0].id !== cleanLayer.id) {
        throw new Error("最终干净文档没有只剩一个目标文字层。");
      }
    }, { commandName: "生成干净文字切图文档" });

    stage = "检查原 PSD 是否被修改";
    if (getLayerText(sourceLayer) !== sourceSnapshot.contents || sourceLayer.name !== sourceSnapshot.name) {
      throw new Error("保护检查失败：原 PSD 的模板文字层发生了变化，请立即撤销原 PSD 的改动。");
    }

    stage = "创建 PNG 文件";
    const output = await createOutputFile(settings.outputName);
    outputFileName = output.fileName;

    setMessage("正在导出透明 PNG…", "muted");

    await core.executeAsModal(async (executionContext) => {
      stage = "导出透明 PNG";
      app.activeDocument = cleanDoc;
      executionContext.reportProgress({ value: 0.90, commandName: stage });

      await cleanDoc.saveAs.png(
        output.file,
        {
          compression: 6,
          interlaced: false,
          method: constants.PNGMethod.QUICK
        },
        true
      );

      executionContext.reportProgress({ value: 0.98, commandName: "导出完成" });

      if (settings.keepWorkDoc) {
        app.activeDocument = cleanDoc;
      } else {
        await closeWithoutSaving(cleanDoc);
        cleanDoc = null;
        app.activeDocument = sourceDoc;
      }
    }, { commandName: "导出透明 PNG" });

    const nativePath = fs.getNativePath(outputFolder) || outputFolder.name;
    const suffix = settings.keepWorkDoc
      ? "；已保留只含 1 个目标文字层的干净工作文档"
      : "；工作文档已关闭";
    setMessage(`✓ 已导出：${nativePath}\\${outputFileName}${suffix}`, "success");
  } catch (err) {
    await cleanupFailedDocs(tempDoc, cleanDoc, sourceDoc);
    tempDoc = null;
    cleanDoc = null;

    setMessage(`失败[${stage}]：${formatError(err)}`, "error");
    console.error(err);
  } finally {
    button.disabled = false;
    try {
      if (!cleanDoc && sourceDoc) {
        app.activeDocument = sourceDoc;
        refreshLayerStatus();
      }
    } catch (_) {}
  }
}

function wireEvents() {
  $("refreshLayerBtn").addEventListener("click", refreshLayerStatus);
  $("chooseFolderBtn").addEventListener("click", chooseFolder);
  $("runBtn").addEventListener("click", generateAndExport);

  $("presetDigits").addEventListener("click", () => {
    $("characters").value = "0123456789";
    saveSettings();
  });

  $("presetDefault").addEventListener("click", () => {
    $("characters").value = "0123456789₹,.+-";
    saveSettings();
  });

  $("clearChars").addEventListener("click", () => {
    $("characters").value = "";
    saveSettings();
  });

  ["characters", "tracking", "padding", "outputName", "keepWorkDoc"].forEach((id) => {
    $(id).addEventListener("change", saveSettings);
  });
}

async function init() {
  restoreSettings();
  wireEvents();
  await restoreFolder();
  refreshLayerStatus();
}

init();

};

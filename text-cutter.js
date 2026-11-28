/* Text Cutter (文字批量切图) - Photoshop UXP.
   Kept from the original: Photoshop text-layer styling, duplicating the template into a
   clean transparent document, protection check of the source PSD, PNG export.
   v2: one clean work document per run (was one full PSD duplicate per character),
   pixels read per text and written as PNGs; uniform height / baseline alignment,
   monospaced digits, sprite atlas export (usable by 图片数字排版), symbol file names,
   overwrite or auto-number, sharp PNG preview. */
module.exports = function mount(root) {
const { app, core, constants, imaging, action } = require("photoshop");
const { storage } = require("uxp");

const fs = storage.localFileSystem;

const STORAGE = {
  text: "textCutter.v110.text",
  tracking: "textCutter.v110.tracking",
  padding: "textCutter.v110.padding",
  outputName: "textCutter.v110.outputName",
  keepWorkDoc: "textCutter.v110.keepWorkDoc",
  folderToken: "textCutter.folderToken",
  v2: "textCutter.v2.options"
};

let outputFolder = null;
let running = false;
let previewRequest = 0;
const opts = { mode: "single", uniform: true, mono: false, gap: 8, withIndex: false, conflict: "overwrite", nameMap: "", keepWorkDoc: true };

function $(id) {
  return root.querySelector("#" + id);
}

function setMessage(text, type = "muted") {
  const el = $("tcpMessage");
  el.textContent = text;
  el.className = `tcp-status ${type}`;
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
    $("tcpLayerName").textContent = layer.name;
    $("tcpLayerMeta").textContent = (textType || "文字图层") + (preview ? " · " + preview : "");
    $("tcpLayerMeta").className = "tcp-layer-meta";
    return true;
  } catch (err) {
    $("tcpLayerName").textContent = "未选择文字模板";
    $("tcpLayerMeta").textContent = formatError(err);
    $("tcpLayerMeta").className = "tcp-layer-meta tcp-warn";
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

    $("tcpFolderPath").textContent = fs.getNativePath(folder) || folder.name;
    $("tcpFolderPath").className = "tcp-folder-path";
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
      $("tcpFolderPath").textContent = fs.getNativePath(entry) || entry.name;
      $("tcpFolderPath").className = "tcp-folder-path";
    }
  } catch (_) {
    localStorage.removeItem(STORAGE.folderToken);
    outputFolder = null;
  }
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

/* ---------- Settings ---------- */

function restoreSettings() {
  const get = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  if (get(STORAGE.text) !== null) $("tcpChars").value = get(STORAGE.text);
  if (get(STORAGE.tracking) !== null) $("tcpTracking").value = get(STORAGE.tracking);
  if (get(STORAGE.padding) !== null) $("tcpPadding").value = get(STORAGE.padding);
  if (get(STORAGE.outputName) !== null) $("tcpOutputName").value = get(STORAGE.outputName);
  if (get(STORAGE.keepWorkDoc) !== null) opts.keepWorkDoc = get(STORAGE.keepWorkDoc) === "true";
  try { Object.assign(opts, JSON.parse(get(STORAGE.v2) || "{}")); } catch (_) {}
  if (!["single", "batch", "atlas"].includes(opts.mode)) opts.mode = "single";
  if (opts.conflict !== "number") opts.conflict = "overwrite";
  $("tcpGap").value = String(Number.isFinite(Number(opts.gap)) ? opts.gap : 8);
  $("tcpNameMap").value = opts.nameMap || "";
}
function saveSettings() {
  try {
    localStorage.setItem(STORAGE.text, $("tcpChars").value);
    localStorage.setItem(STORAGE.tracking, $("tcpTracking").value);
    localStorage.setItem(STORAGE.padding, $("tcpPadding").value);
    localStorage.setItem(STORAGE.outputName, $("tcpOutputName").value);
    localStorage.setItem(STORAGE.keepWorkDoc, String(opts.keepWorkDoc));
    opts.gap = Number($("tcpGap").value);
    opts.nameMap = $("tcpNameMap").value;
    localStorage.setItem(STORAGE.v2, JSON.stringify(opts));
  } catch (_) {}
}

function readNumbers() {
  const tracking = Number($("tcpTracking").value), padding = Number($("tcpPadding").value), gap = Number($("tcpGap").value);
  if (!Number.isFinite(tracking) || tracking < -1000 || tracking > 1000) throw new Error("Tracking 请输入 -1000 到 1000 之间的数值。");
  if (!Number.isFinite(padding) || padding < 0 || padding > 2000) throw new Error("透明边距请输入 0 到 2000 之间的数值。");
  if (!Number.isFinite(gap) || gap < 1 || gap > 500) throw new Error("字符间隔请输入 1 到 500 之间的数值。");
  return { tracking, padding: Math.round(padding), gap: Math.round(gap) };
}
function stringText() { return String($("tcpChars").value || "").replace(/[\r\n]/g, ""); }
function uniqueChars() { return Array.from(new Set(Array.from(stringText()).filter(ch => ch.trim() !== ""))); }
const isDigit = ch => /^[0-9]$/.test(ch);

/* ---------- File names ---------- */

const SYMBOL_NAMES = { ".": "dot", ",": "comma", "+": "plus", "-": "minus", "%": "percent", ":": "colon", "/": "slash", "\\": "backslash",
  "*": "star", "₹": "rupee", "$": "dollar", "€": "euro", "¥": "yen", "£": "pound", "#": "hash", "!": "exclam", "?": "question",
  "(": "lparen", ")": "rparen", "[": "lbracket", "]": "rbracket", "=": "equal", "@": "at", "&": "and", "'": "apos", "\"": "quote",
  "<": "lt", ">": "gt", "|": "bar", "~": "tilde", "^": "caret", "_": "underscore", "×": "times", "x": "x" };
function customNames() {
  const map = new Map();
  String($("tcpNameMap").value || "").split(/\s+/).forEach(token => {
    const at = token.indexOf("=", 1); // key may itself be "=", e.g. "==equal"
    if (at > 0 && at < token.length - 1) map.set(token.slice(0, at), token.slice(at + 1));
  });
  return map;
}
function charNames(chars) {
  const custom = customNames(), lower = new Set(chars.filter(c => /^[a-z]$/.test(c)));
  return chars.map(ch => {
    if (custom.has(ch)) return custom.get(ch);
    if (/^[0-9a-z]$/.test(ch)) return ch;
    // Windows file names ignore case, so "A" would collide with "a".
    if (/^[A-Z]$/.test(ch)) return lower.has(ch.toLowerCase()) ? ch + "_upper" : ch;
    return SYMBOL_NAMES[ch] || ("u" + ch.codePointAt(0).toString(16));
  });
}
function batchFileBases(chars) {
  const prefix = safeName($("tcpOutputName").value), names = charNames(chars);
  return chars.map((ch, i) => safeFileName(prefix + "_" + (opts.withIndex ? String(i + 1).padStart(2, "0") + "_" : "") + names[i]));
}

/* ---------- UI state ---------- */

function setSeg(selector, attr, value) {
  root.querySelectorAll(selector).forEach(el => {
    const on = el.getAttribute(attr) === value;
    el.classList.toggle("tcp-selected", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  });
}
function setCheck(id, on) { $(id).setAttribute("aria-checked", on ? "true" : "false"); }

function refreshView() {
  const mode = opts.mode, chars = uniqueChars();
  setSeg(".tcp-mode", "data-mode", mode);
  setSeg(".tcp-conflict", "data-conflict", opts.conflict);
  setCheck("tcpUniformRow", opts.uniform);
  setCheck("tcpMonoRow", opts.mono);
  setCheck("tcpIndexRow", opts.withIndex);
  setCheck("tcpKeepRow", opts.keepWorkDoc);
  $("tcpUniformRow").style.display = mode === "batch" ? "flex" : "none";
  $("tcpMonoRow").style.display = mode === "single" ? "none" : "flex";
  $("tcpGapRow").style.display = mode === "atlas" ? "flex" : "none";
  $("tcpNamingBox").style.display = mode === "batch" ? "block" : "none";
  $("tcpKeepRow").style.display = mode === "single" ? "flex" : "none";
  $("tcpNameLabel").textContent = mode === "batch" ? "文件名前缀" : mode === "atlas" ? "图集文件名" : "文件名";
  const n = mode === "batch" ? chars.length : (stringText().trim() ? 1 : 0);
  $("tcpCount").textContent = mode === "single" ? stringText().length + " 个字" : chars.length + " 个不同字符";
  $("tcpModeNote").textContent = mode === "single" ? "整串内容导出为一张 PNG。"
    : mode === "batch" ? "每个不同字符各导出一张 PNG（共 " + n + " 张）。"
    : "所有不同字符排成一行，导出为一张图集；可直接在「图片数字排版」导入，字符映射填：" + chars.join("");
  if (mode === "batch" && chars.length) {
    const bases = batchFileBases(chars.slice(0, 3));
    $("tcpNameExample").textContent = "示例：" + bases.map(b => b + ".png").join("、") + (chars.length > 3 ? "…" : "");
  } else $("tcpNameExample").textContent = "";
  $("tcpRun").textContent = running ? "正在导出…" : mode === "batch" ? "导出 " + n + " 张 PNG" : mode === "atlas" ? "导出字库图集" : "导出 PNG";
}

function markPreviewStale(text) {
  previewRequest++;
  $("tcpPreviewImage").style.display = "none";
  $("tcpPreviewPlaceholder").style.display = "block";
  $("tcpPreviewPlaceholder").textContent = text || "设置已修改，点「更新预览」查看";
}

/* ---------- Render: one clean work document, one text at a time ---------- */

// Returns [{ text, l, t, r, b, w, h, rgba }] in work-document coordinates. All texts are set
// on the same point-text layer without moving it, so they share one baseline.
async function renderTexts(texts, numbers, keepWork) {
  const source = getCurrentTextLayer();
  const sourceDoc = source.doc, sourceLayer = source.layer;
  const snapshot = { docId: sourceDoc.id, layerId: sourceLayer.id, name: sourceLayer.name, contents: getLayerText(sourceLayer) };
  const outputName = safeName($("tcpOutputName").value);
  const items = [];
  let tempDoc = null, workDoc = null, resolution = 72, profile = "";
  try {
    await core.executeAsModal(async (ctx) => {
      ctx.reportProgress({ value: 0.05, commandName: "复制临时工作副本" });
      app.activeDocument = sourceDoc;
      tempDoc = await sourceDoc.duplicate("__TEXTCUTTER_TEMP__", false);
      if (!tempDoc || tempDoc.id === snapshot.docId) throw new Error("临时工作副本复制失败。");
      app.activeDocument = tempDoc;
      const tempLayer = findTemplateInDuplicatedDocument(tempDoc, snapshot);
      const longest = texts.join("");
      await updateTextLayer(tempLayer, { text: longest, tracking: numbers.tracking });
      await ensureLayerFitsDocument(tempDoc, tempLayer, numbers.padding);
      resolution = toNumber(tempDoc.resolution) || 72;

      ctx.reportProgress({ value: 0.2, commandName: "抽取文字图层" });
      workDoc = await app.documents.add({
        name: outputName, width: Math.max(1, Math.ceil(toNumber(tempDoc.width))), height: Math.max(1, Math.ceil(toNumber(tempDoc.height))),
        resolution: tempDoc.resolution, mode: "RGBColorMode", fill: "transparent"
      });
      const initialIds = new Set(Array.from(workDoc.layers || []).map(l => l.id));
      let layer = await extractTargetLayer(tempDoc, tempLayer, workDoc, { text: longest, outputName }, initialIds);
      await removeOnlyAutoBlankLayers(workDoc, initialIds, layer);
      await closeWithoutSaving(tempDoc);
      tempDoc = null;
      app.activeDocument = workDoc;

      // Generous room on every side, added once, so no text needs the layer to move.
      const b0 = getBounds(layer);
      const room = Math.ceil(Math.max(300, boundsHeight(b0) * 2, numbers.padding + 50));
      await workDoc.resizeCanvas(Math.ceil(toNumber(workDoc.width)) + room * 2, Math.ceil(toNumber(workDoc.height)) + room * 2, constants.AnchorPosition.MIDDLECENTER);
      const W = toNumber(workDoc.width), H = toNumber(workDoc.height);

      for (let i = 0; i < texts.length; i++) {
        ctx.reportProgress({ value: 0.25 + 0.7 * i / texts.length, commandName: "读取 " + texts[i] });
        await updateTextLayer(layer, { text: texts[i], tracking: numbers.tracking });
        layer = findCleanTextLayer(workDoc, texts[i], layer.id);
        const b = getBounds(layer);
        if (boundsWidth(b) <= 0 || boundsHeight(b) <= 0) { items.push({ text: texts[i], empty: true }); continue; }
        if (b.left < 0 || b.top < 0 || b.right > W || b.bottom > H) throw new Error("「" + texts[i] + "」超出了临时画布，请缩小字号后再试。");
        const rect = { left: Math.floor(b.left), top: Math.floor(b.top), right: Math.ceil(b.right), bottom: Math.ceil(b.bottom) };
        const res = await imaging.getPixels({ documentID: workDoc.id, sourceBounds: rect, colorSpace: "RGB", componentSize: 8, applyAlpha: false });
        const image = res.imageData;
        try {
          profile = profile || image.colorProfile || "";
          const data = await image.getData({ chunky: true }), w = image.width, h = image.height, c = image.components;
          const sb = res.sourceBounds || rect;
          const rgba = c === 4 ? new Uint8Array(data) : new Uint8Array(w * h * 4);
          if (c !== 4) for (let p = 0; p < w * h; p++) { rgba[p * 4] = data[p * c]; rgba[p * 4 + 1] = data[p * c + 1]; rgba[p * 4 + 2] = data[p * c + 2]; rgba[p * 4 + 3] = 255; }
          const l = Number(sb.left), t = Number(sb.top);
          items.push({ text: texts[i], l, t, r: l + w, b: t + h, w, h, rgba });
        } finally { image.dispose(); }
      }

      if (keepWork) {
        await cropCleanDocToLayer(workDoc, layer, numbers.padding);
        app.activeDocument = workDoc;
      } else {
        await closeWithoutSaving(workDoc);
        workDoc = null;
        app.activeDocument = sourceDoc;
      }
    }, { commandName: "文字批量切图：生成" });
  } catch (err) {
    await cleanupFailedDocs(tempDoc, workDoc, sourceDoc);
    throw err;
  }
  if (getLayerText(sourceLayer) !== snapshot.contents || sourceLayer.name !== snapshot.name)
    throw new Error("保护检查失败：原 PSD 的模板文字层发生了变化，请立即撤销原 PSD 的改动。");
  return { items, resolution, profile };
}

function blit(dst, dw, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++) {
    const ty = oy + y; if (ty < 0) continue;
    for (let x = 0; x < sw; x++) {
      const tx = ox + x; if (tx < 0 || tx >= dw) continue;
      const si = (y * sw + x) * 4, di = (ty * dw + tx) * 4;
      dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3];
    }
  }
}

// Turn measured items into output images according to the mode and options.
function layoutImages(items, mode, numbers, bases) {
  const p = numbers.padding, visible = items.filter(i => !i.empty);
  if (!visible.length) throw new Error("没有可导出的可见字符。");
  const minT = Math.min(...visible.map(i => i.t)), maxB = Math.max(...visible.map(i => i.b));
  const monoW = opts.mono && mode !== "single" ? Math.max(0, ...visible.filter(i => isDigit(i.text)).map(i => i.w)) : 0;
  const cellW = i => (monoW && isDigit(i.text)) ? monoW : i.w;
  if (mode === "atlas") {
    const W = visible.reduce((s, i) => s + cellW(i), 0) + numbers.gap * (visible.length - 1) + p * 2, H = maxB - minT + p * 2;
    const rgba = new Uint8Array(W * H * 4);
    let x = p;
    for (const i of visible) { blit(rgba, W, i.rgba, i.w, i.h, x + Math.round((cellW(i) - i.w) / 2), p + i.t - minT); x += cellW(i) + numbers.gap; }
    return [{ base: bases[0], w: W, h: H, rgba }];
  }
  return items.map((i, k) => {
    if (i.empty) return null;
    const uniform = mode === "batch" && opts.uniform;
    const W = cellW(i) + p * 2, H = (uniform ? maxB - minT : i.h) + p * 2;
    const rgba = new Uint8Array(W * H * 4);
    blit(rgba, W, i.rgba, i.w, i.h, p + Math.round((cellW(i) - i.w) / 2), p + (uniform ? i.t - minT : 0));
    return { base: bases[k], w: W, h: H, rgba };
  }).filter(Boolean);
}

async function writePngs(images, resolution, profile) {
  const existing = new Set((await outputFolder.getEntries()).map(e => e.name.toLowerCase()));
  const written = [];
  await core.executeAsModal(async (ctx) => {
    for (let k = 0; k < images.length; k++) {
      const img = images[k];
      let name = img.base + ".png";
      if (opts.conflict === "number") { let n = 2; while (existing.has(name.toLowerCase())) name = img.base + "_" + (n++) + ".png"; }
      existing.add(name.toLowerCase());
      ctx.reportProgress({ value: k / images.length, commandName: "导出 " + name });
      const doc = await app.documents.add({ name: name.replace(/\.png$/i, ""), width: img.w, height: img.h, resolution, mode: "RGBColorMode", fill: "transparent" });
      try {
        const target = Array.from(doc.layers)[0];
        const options = { width: img.w, height: img.h, components: 4, chunky: true, colorSpace: "RGB" };
        if (profile) options.colorProfile = profile;
        const data = await imaging.createImageDataFromBuffer(img.rgba, options);
        try { await imaging.putPixels({ documentID: doc.id, layerID: target.id, imageData: data, targetBounds: { left: 0, top: 0 }, replace: true, commandName: "写入切图像素" }); }
        finally { data.dispose(); }
        const file = await outputFolder.createFile(name, { overwrite: true });
        await doc.saveAs.png(file, { compression: 6, interlaced: false, method: constants.PNGMethod.QUICK }, true);
        written.push(name);
      } finally { await closeWithoutSaving(doc); }
    }
  }, { commandName: "文字批量切图：导出 PNG" });
  return written;
}

function plan() {
  const numbers = readNumbers();
  const mode = opts.mode;
  if (mode === "single") {
    const text = stringText();
    if (!text.replace(/[\t ]/g, "")) throw new Error("文字内容不能为空。");
    return { numbers, mode, texts: [text], bases: [safeFileName($("tcpOutputName").value)] };
  }
  const chars = uniqueChars();
  if (!chars.length) throw new Error("请输入需要导出的字符。");
  return { numbers, mode, texts: chars, bases: mode === "batch" ? batchFileBases(chars) : [safeFileName($("tcpOutputName").value)] };
}

function setRunning(on) {
  running = on;
  ["tcpRun", "tcpPreviewBtn"].forEach(id => $(id).classList.toggle("tcp-busy", on));
  refreshView();
}

async function exportRequested() {
  if (running) return;
  let job;
  try {
    job = plan();
    getCurrentTextLayer();
    if (!outputFolder) { await chooseFolder(); if (!outputFolder) throw new Error("请先选择 PNG 保存文件夹。"); }
  } catch (err) { setMessage(formatError(err), "error"); return; }
  saveSettings();
  setRunning(true);
  try {
    setMessage("正在生成…（" + job.texts.length + " 项）", "muted");
    const keep = job.mode === "single" && opts.keepWorkDoc;
    const { items, resolution, profile } = await renderTexts(job.texts, job.numbers, keep);
    const images = layoutImages(items, job.mode, job.numbers, job.bases);
    const written = await writePngs(images, resolution, profile);
    const skipped = items.filter(i => i.empty).map(i => "「" + i.text + "」");
    const path = fs.getNativePath(outputFolder) || outputFolder.name;
    let text = "✓ 已导出 " + written.length + " 张 PNG 到 " + path + "\n" + written.slice(0, 6).join("、") + (written.length > 6 ? "…" : "");
    if (job.mode === "atlas") text += "\n在「图片数字排版」导入这张图集，字符映射填：" + job.texts.join("");
    if (skipped.length) text += "\n跳过没有可见像素的字符：" + skipped.join(" ");
    if (keep) text += "\n已保留只含 1 个文字图层的工作文档。";
    setMessage(text, "success");
  } catch (err) {
    console.error(err);
    setMessage("导出失败：" + formatError(err) + "\n原始 PSD 未修改。", "error");
  } finally {
    setRunning(false);
    try { refreshLayerStatus(); } catch (_) {}
  }
}

/* ---------- Sharp PNG preview (same encoder as the other tools) ---------- */

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes, start, end) { let c = 0xFFFFFFFF; for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "", i = 0;
  for (; i + 2 < bytes.length; i += 3) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]; out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]; }
  if (i < bytes.length) { const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8); out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "="; }
  return out;
}
function encodePngRGB(rgb, w, h) {
  const stride = w * 3 + 1, raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * stride + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let p = 0, a = 1, b = 0; z[p++] = 0x78; z[p++] = 0x01;
  for (let i = 0; i < blocks; i++) { const from = i * 65535, len = Math.min(65535, raw.length - from); z[p++] = i === blocks - 1 ? 1 : 0; z[p++] = len & 255; z[p++] = len >> 8; z[p++] = ~len & 255; z[p++] = (~len >> 8) & 255; z.set(raw.subarray(from, from + len), p); p += len; }
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  z[p++] = b >> 8; z[p++] = b & 255; z[p++] = a >> 8; z[p++] = a & 255;
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const chunks = [["IHDR", ihdr], ["IDAT", z], ["IEND", new Uint8Array(0)]];
  const png = new Uint8Array(8 + chunks.reduce((s, c) => s + 12 + c[1].length, 0)), view = new DataView(png.buffer);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  for (const [type, data] of chunks) { view.setUint32(o, data.length); o += 4; const ts = o; for (let k = 0; k < 4; k++) png[o++] = type.charCodeAt(k); png.set(data, o); o += data.length; view.setUint32(o, crc32(png, ts, o)); o += 4; }
  return "data:image/png;base64," + base64(png);
}
function previewUrl(data, w, h, k) {
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k)), rgb = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.min(h - 1, Math.floor(y / k)), sy1 = k < 1 ? Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) / k))) : sy0 + 1;
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.min(w - 1, Math.floor(x / k)), sx1 = k < 1 ? Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) / k))) : sx0 + 1;
      let r = 0, g = 0, bl = 0, al = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) { const i = (sy * w + sx) * 4, a = data[i + 3] / 255; r += data[i] * a; g += data[i + 1] * a; bl += data[i + 2] * a; al += a; n++; }
      const alpha = al / n, bg = ((Math.floor(x / 6) + Math.floor(y / 6)) % 2) ? 58 : 74, j = (y * dw + x) * 3;
      rgb[j] = Math.round(r / n + bg * (1 - alpha)); rgb[j + 1] = Math.round(g / n + bg * (1 - alpha)); rgb[j + 2] = Math.round(bl / n + bg * (1 - alpha));
    }
  }
  return { url: encodePngRGB(rgb, dw, dh), width: dw, height: dh };
}

async function previewRequested() {
  if (running) return;
  let job;
  try { job = plan(); getCurrentTextLayer(); } catch (err) { markPreviewStale(formatError(err)); return; }
  const request = ++previewRequest;
  setRunning(true);
  $("tcpPreviewPlaceholder").textContent = "正在生成 Photoshop 文字预览…";
  try {
    const { items } = await renderTexts(job.texts, job.numbers, false);
    // Batch preview: the individual images side by side with a small gap, as exported.
    let images = layoutImages(items, job.mode, job.numbers, job.bases);
    let sheet = images[0];
    if (images.length > 1) {
      const gap = 6, W = images.reduce((s, i) => s + i.w, 0) + gap * (images.length - 1), H = Math.max(...images.map(i => i.h));
      const rgba = new Uint8Array(W * H * 4);
      let x = 0;
      for (const i of images) { blit(rgba, W, i.rgba, i.w, i.h, x, 0); x += i.w + gap; }
      sheet = { w: W, h: H, rgba };
    }
    if (request !== previewRequest) return;
    const holder = $("tcpPreview");
    const k = Math.min(((holder.clientWidth || 340) - 14) / sheet.w, ((holder.clientHeight || 120) - 14) / sheet.h, 3);
    const out = previewUrl(sheet.rgba, sheet.w, sheet.h, k);
    $("tcpPreviewImage").src = out.url;
    $("tcpPreviewImage").style.display = "block";
    $("tcpPreviewPlaceholder").style.display = "none";
    $("tcpPreviewNote").textContent = (job.mode === "batch" ? images.length + " 张，" : "") + "单张尺寸：" +
      Array.from(new Set(images.map(i => i.w + "×" + i.h))).slice(0, 4).join("、") + (images.length > 4 ? "…" : "") + " px · 原始 PSD 未修改";
  } catch (err) {
    if (request === previewRequest) { markPreviewStale("预览暂不可用，可继续导出"); $("tcpPreviewNote").textContent = formatError(err); }
  } finally { setRunning(false); }
}

/* ---------- Events ---------- */

function onActivate(el, handler) {
  el.addEventListener("click", handler);
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } });
}
function changed(stale) { saveSettings(); refreshView(); if (stale) markPreviewStale(); }

function wireEvents() {
  onActivate($("tcpRefresh"), () => { refreshLayerStatus(); markPreviewStale(); });
  onActivate($("tcpPreviewBtn"), previewRequested);
  onActivate($("tcpRun"), exportRequested);
  onActivate($("tcpChooseFolder"), chooseFolder);
  onActivate($("tcpPresetDigits"), () => { $("tcpChars").value = "0123456789"; changed(true); });
  onActivate($("tcpPresetDefault"), () => { $("tcpChars").value = "0123456789₹,.+-"; changed(true); });
  onActivate($("tcpClear"), () => { $("tcpChars").value = ""; changed(true); });
  root.querySelectorAll(".tcp-mode").forEach(el => onActivate(el, () => { opts.mode = el.getAttribute("data-mode"); changed(true); }));
  root.querySelectorAll(".tcp-conflict").forEach(el => onActivate(el, () => { opts.conflict = el.getAttribute("data-conflict"); changed(false); }));
  onActivate($("tcpUniformRow"), () => { opts.uniform = !opts.uniform; changed(true); });
  onActivate($("tcpMonoRow"), () => { opts.mono = !opts.mono; changed(true); });
  onActivate($("tcpIndexRow"), () => { opts.withIndex = !opts.withIndex; changed(false); });
  onActivate($("tcpKeepRow"), () => { opts.keepWorkDoc = !opts.keepWorkDoc; changed(false); });
  ["tcpChars", "tcpTracking", "tcpPadding", "tcpGap"].forEach(id => $(id).addEventListener("input", () => { refreshView(); markPreviewStale(); }));
  ["tcpChars", "tcpTracking", "tcpPadding", "tcpGap", "tcpOutputName", "tcpNameMap"].forEach(id => $(id).addEventListener("change", () => changed(false)));
  ["tcpOutputName", "tcpNameMap"].forEach(id => $(id).addEventListener("input", refreshView));
}

async function init() {
  restoreSettings();
  wireEvents();
  await restoreFolder();
  refreshLayerStatus();
  refreshView();
  root.__textCutterActivate = () => { if (!running) refreshLayerStatus(); };
  try {
    action.addNotificationListener(["select", "open", "close"], (name, descriptor) => {
      if (root.style.display === "none" || running) return;
      if (name === "select") {
        const arr = descriptor && descriptor._target;
        if (Array.isArray(arr) && !arr.some(t => t && (t._ref === "layer" || t._ref === "document"))) return;
      }
      refreshLayerStatus();
      markPreviewStale("模板已变化，点「更新预览」查看");
    });
  } catch (err) { console.warn("[Text Cutter] Cannot listen to selection changes", err); }
}

init();

};

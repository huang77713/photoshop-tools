/* Transparent Split (透明对象拆分) - Photoshop UXP.
   Original approach kept: read the layer's transparent pixels, find connected regions,
   write each region to its own new layer inside a result group; the source layer's
   pixels are never modified.
   v2: per-pixel ownership (no neighbour pixels copied), merge gap, click to merge /
   exclude in the preview, sort modes, name list, keep opacity / blend mode,
   optional hide source, one-step undo, sharp PNG preview. */
module.exports = function mount(root) {
const { app, core, action, constants, imaging } = require("photoshop");

const STORAGE = {
  groupName: "transparentSplit.test.groupName",
  layerPrefix: "transparentSplit.test.layerPrefix",
  minAreaPercent: "transparentSplit.test.minAreaPercent",
  padding: "transparentSplit.test.padding",
  mergeGap: "transparentSplit.v2.mergeGap",
  sort: "transparentSplit.v2.sort",
  nameList: "transparentSplit.v2.nameList",
  hideSource: "transparentSplit.v2.hideSource",
  output: "transparentSplit.v2.output"
};

// Pixels below this alpha are treated as empty when finding regions; they are still
// copied as soft edges inside the "柔边保留" margin if no other object owns them.
const ALPHA_THRESHOLD = 8;
const MAX_COMPONENTS = 100;
const MAX_MERGE_GAP = 50;
const SORTS = ["reading", "ltr", "ttb", "size"];

function $(id) {
  return root.querySelector("#" + id);
}

function setMessage(text, type = "muted") {
  const el = $("message");
  el.textContent = text;
  el.className = `message tsp-status ${type}`;
}

function formatError(err) {
  if (!err) return "未知错误";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch (_) {}
  try { return String(err); } catch (_) { return "未知错误"; }
}

function safeName(value, fallback) {
  const name = String(value || "").trim();
  return name || fallback;
}

function readNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function store(key, value) { try { localStorage.setItem(key, String(value)); } catch (_) {} }
function load(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

/* ---------- Layer helpers (original) ---------- */

function getCurrentLayer() {
  if (!app.documents || app.documents.length === 0) throw new Error("请先打开一个 Photoshop 文档。");
  const doc = app.activeDocument;
  const selected = doc.activeLayers;
  if (!selected || selected.length !== 1) throw new Error("请只选中 1 个已经去好背景的透明图片图层。");
  const layer = selected[0];
  if (layer.kind === constants.LayerKind.GROUP) throw new Error("当前选中的是图层组。请选中真正的透明图片图层。");
  return { doc, layer };
}

function layerKindLabel(layer) {
  try {
    if (layer.isBackgroundLayer) return "背景图层";
    if (layer.kind === constants.LayerKind.SMARTOBJECT) return "智能对象";
    if (layer.kind === constants.LayerKind.NORMAL) return "像素图层";
    return "图层";
  } catch (_) {
    return "图层";
  }
}

function refreshLayerStatus() {
  try {
    const { layer } = getCurrentLayer();
    $("tspLayerName").textContent = layer.name;
    $("layerStatus").textContent = layerKindLabel(layer);
    $("layerStatus").className = "tsp-layer-meta";
    return true;
  } catch (err) {
    $("tspLayerName").textContent = "未选择可用图层";
    $("layerStatus").textContent = formatError(err);
    $("layerStatus").className = "tsp-layer-meta tsp-warn";
    return false;
  }
}

async function selectLayerById(layerId) {
  await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: layerId }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } }], {});
}

async function convertActiveLayerToSmartObject() {
  await action.batchPlay([{ _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }], {});
}

async function readTransparentPixels(doc, layer) {
  const result = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, colorSpace: "RGB", componentSize: 8, applyAlpha: false });
  if (!result || !result.imageData) throw new Error("无法读取当前透明图层的像素。");
  const imageData = result.imageData;
  const width = imageData.width, height = imageData.height, components = imageData.components;
  const sourceBounds = result.sourceBounds;
  if (!imageData.hasAlpha || components !== 4) {
    try { imageData.dispose(); } catch (_) {}
    throw new Error("当前图层没有可读取的透明 Alpha。请先手动去掉背景后再运行。");
  }
  const data = await imageData.getData({ chunky: true });
  try { imageData.dispose(); } catch (_) {}
  return { data, width, height, components, sourceBounds };
}

/* ---------- Region detection ---------- */

// Run-length union-find. Two runs join when the empty gap between them is <= gap pixels
// (gap 0 = touching, including diagonals, exactly as before). Returns the kept regions,
// and a per-pixel owner map (0 = no region, otherwise region index + 1).
function buildConnectedComponents(pixelData, width, height, components, minArea, gap) {
  if (components !== 4) throw new Error(`透明像素读取异常：期望 RGBA 4 通道，实际 ${components} 通道。`);
  const g = Math.max(0, Math.min(MAX_MERGE_GAP, Math.floor(gap || 0)));
  const runY = [], runStart = [], runEnd = [], parent = [], rank = [];
  const rows = [];
  const alphaAt = (x, y) => pixelData[(y * width + x) * 4 + 3];
  function find(i) {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  }
  function union(a, b) {
    let ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra] += 1;
  }

  let visiblePixels = 0, transparentPixels = 0;
  for (let y = 0; y < height; y++) {
    const current = [];
    let x = 0;
    while (x < width) {
      while (x < width && alphaAt(x, y) < ALPHA_THRESHOLD) { transparentPixels++; x++; }
      if (x >= width) break;
      const start = x;
      while (x < width && alphaAt(x, y) >= ALPHA_THRESHOLD) { visiblePixels++; x++; }
      const id = runY.length;
      runY.push(y); runStart.push(start); runEnd.push(x - 1); parent.push(id); rank.push(0);
      if (g > 0 && current.length && start - runEnd[current[current.length - 1]] - 1 <= g) union(id, current[current.length - 1]);
      current.push(id);
    }
    // Compare with the previous g+1 rows; horizontal reach is extended by g.
    for (let d = 1; d <= g + 1 && y - d >= 0; d++) {
      const previous = rows[y - d];
      let p = 0;
      for (const id of current) {
        while (p < previous.length && runEnd[previous[p]] < runStart[id] - 1 - g) p++;
        for (let q = p; q < previous.length && runStart[previous[q]] <= runEnd[id] + 1 + g; q++) union(id, previous[q]);
      }
    }
    rows.push(current);
  }
  if (visiblePixels === 0) throw new Error("当前图层没有检测到可见内容。");

  const byRoot = new Map();
  for (let i = 0; i < runY.length; i++) {
    const r = find(i), area = runEnd[i] - runStart[i] + 1;
    let item = byRoot.get(r);
    if (!item) { item = { area: 0, minX: runStart[i], maxX: runEnd[i], minY: runY[i], maxY: runY[i] }; byRoot.set(r, item); }
    item.area += area;
    if (runStart[i] < item.minX) item.minX = runStart[i];
    if (runEnd[i] > item.maxX) item.maxX = runEnd[i];
    if (runY[i] < item.minY) item.minY = runY[i];
    if (runY[i] > item.maxY) item.maxY = runY[i];
  }
  const kept = [];
  const indexOfRoot = new Map();
  byRoot.forEach((item, r) => { if (item.area >= minArea) { indexOfRoot.set(r, kept.length); kept.push(item); } });
  if (kept.length > MAX_COMPONENTS) throw new Error(`识别到 ${kept.length} 个独立碎片，数量过多。请提高「最小面积」或「合并间距」。`);

  const labels = new Uint8Array(width * height);
  for (let i = 0; i < runY.length; i++) {
    const index = indexOfRoot.get(find(i));
    if (index === undefined) continue;
    labels.fill(index + 1, runY[i] * width + runStart[i], runY[i] * width + runEnd[i] + 1);
  }
  return { items: kept, labels, hasTransparentGap: transparentPixels > 0 };
}

/* ---------- Objects (regions after manual merge / exclude) ---------- */

let nextObjectId = 1;
function makeObjects(items) {
  return items.map((_, i) => ({ id: nextObjectId++, parts: [i], excluded: false }));
}

function objectRect(obj, items) {
  const r = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, area: 0 };
  for (const i of obj.parts) {
    const it = items[i];
    r.minX = Math.min(r.minX, it.minX); r.minY = Math.min(r.minY, it.minY);
    r.maxX = Math.max(r.maxX, it.maxX); r.maxY = Math.max(r.maxY, it.maxY);
    r.area += it.area;
  }
  return r;
}

function sortObjects(objects, items, mode) {
  const withRect = objects.map(o => ({ o, r: objectRect(o, items) }));
  if (mode === "reading") {
    // Group into visual rows first (an object joins a row when their vertical spans
    // share the other's centre), then read each row left to right. Small pieces that
    // sit inside a big glyph's height stay in that glyph's row.
    const rows = [];
    withRect.slice().sort((a, b) => a.r.minY - b.r.minY).forEach(item => {
      const cy = (item.r.minY + item.r.maxY) / 2;
      const row = rows.find(rw => (cy >= rw.minY && cy <= rw.maxY) || ((rw.minY + rw.maxY) / 2 >= item.r.minY && (rw.minY + rw.maxY) / 2 <= item.r.maxY));
      if (row) { row.list.push(item); row.minY = Math.min(row.minY, item.r.minY); row.maxY = Math.max(row.maxY, item.r.maxY); }
      else rows.push({ minY: item.r.minY, maxY: item.r.maxY, list: [item] });
    });
    rows.sort((a, b) => a.minY - b.minY);
    return [].concat(...rows.map(rw => rw.list.sort((a, b) => a.r.minX - b.r.minX || a.r.minY - b.r.minY).map(x => x.o)));
  }
  withRect.sort((a, b) => {
    const A = a.r, B = b.r;
    if (mode === "ltr") return A.minX - B.minX || A.minY - B.minY;
    if (mode === "ttb") return A.minY - B.minY || A.minX - B.minX;
    if (mode === "size") return B.area - A.area || A.minY - B.minY;
    // Reading order (original): same visual row when centres are close, then left to right.
    const acy = (A.minY + A.maxY) / 2, bcy = (B.minY + B.maxY) / 2;
    const tolerance = Math.max(12, Math.min(A.maxY - A.minY + 1, B.maxY - B.minY + 1) * 0.45);
    if (Math.abs(acy - bcy) <= tolerance) return A.minX - B.minX;
    return acy - bcy;
  });
  return withRect.map(x => x.o);
}

// Shrink the soft-edge margin so it never reaches halfway into another object's box.
function safePadding(rect, others, requestedPadding) {
  let leftGap = Infinity, rightGap = Infinity, topGap = Infinity, bottomGap = Infinity;
  const r = { l: rect.minX, t: rect.minY, r: rect.maxX + 1, b: rect.maxY + 1 };
  for (const o of others) {
    const q = { l: o.minX, t: o.minY, r: o.maxX + 1, b: o.maxY + 1 };
    if (!(q.b <= r.t || q.t >= r.b)) {
      if (q.r <= r.l) leftGap = Math.min(leftGap, r.l - q.r);
      if (q.l >= r.r) rightGap = Math.min(rightGap, q.l - r.r);
    }
    if (!(q.r <= r.l || q.l >= r.r)) {
      if (q.b <= r.t) topGap = Math.min(topGap, r.t - q.b);
      if (q.t >= r.b) bottomGap = Math.min(bottomGap, q.t - r.b);
    }
  }
  const padFor = g => Number.isFinite(g) ? Math.min(requestedPadding, Math.max(0, Math.floor(g / 2))) : requestedPadding;
  return { left: padFor(leftGap), right: padFor(rightGap), top: padFor(topGap), bottom: padFor(bottomGap) };
}

// Copy only pixels that belong to this object, plus unowned faint pixels (soft edges)
// inside its margin. Pixels owned by any other object are left transparent.
function objectPixels(pixels, labels, obj, rect, pad) {
  const W = pixels.width, H = pixels.height;
  const left = Math.max(0, rect.minX - pad.left), top = Math.max(0, rect.minY - pad.top);
  const right = Math.min(W, rect.maxX + 1 + pad.right), bottom = Math.min(H, rect.maxY + 1 + pad.bottom);
  const w = right - left, h = bottom - top;
  if (w < 1 || h < 1) return null;
  const own = new Uint8Array(256);
  for (const i of obj.parts) own[i + 1] = 1;
  const out = new Uint8Array(w * h * 4), src = pixels.data;
  for (let y = 0; y < h; y++) {
    const rowStart = (top + y) * W + left;
    for (let x = 0; x < w; x++) {
      const idx = rowStart + x, lab = labels[idx];
      if (lab !== 0 && !own[lab]) continue;
      const s = idx * 4, d = (y * w + x) * 4;
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
    }
  }
  return { data: out, left, top, width: w, height: h };
}

/* ---------- Sharp PNG preview (same encoder as the image-number tool) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "", i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + "=";
  }
  return out;
}
function encodePngRGB(rgb, w, h) {
  const stride = w * 3 + 1, raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * stride + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let p = 0, a = 1, b = 0;
  z[p++] = 0x78; z[p++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const from = i * 65535, len = Math.min(65535, raw.length - from);
    z[p++] = i === blocks - 1 ? 1 : 0; z[p++] = len & 255; z[p++] = len >> 8; z[p++] = ~len & 255; z[p++] = (~len >> 8) & 255;
    z.set(raw.subarray(from, from + len), p); p += len;
  }
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
  z[p++] = b >> 8; z[p++] = b & 255; z[p++] = a >> 8; z[p++] = a & 255;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  const chunks = [["IHDR", ihdr], ["IDAT", z], ["IEND", new Uint8Array(0)]];
  const png = new Uint8Array(8 + chunks.reduce((s, c) => s + 12 + c[1].length, 0)), view = new DataView(png.buffer);
  png.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  for (const [type, data] of chunks) {
    view.setUint32(o, data.length); o += 4;
    const typeStart = o;
    for (let k = 0; k < 4; k++) png[o++] = type.charCodeAt(k);
    png.set(data, o); o += data.length;
    view.setUint32(o, crc32(png, typeStart, o)); o += 4;
  }
  return "data:image/png;base64," + base64(png);
}
// Nearest neighbour when enlarging (sharp), area average when shrinking; checkerboard behind.
function previewUrl(data, w, h, k) {
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
  const rgb = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.min(h - 1, Math.floor(y / k)), sy1 = k < 1 ? Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) / k))) : sy0 + 1;
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.min(w - 1, Math.floor(x / k)), sx1 = k < 1 ? Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) / k))) : sx0 + 1;
      let r = 0, g = 0, b = 0, al = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * w + sx) * 4, a = data[i + 3] / 255;
        r += data[i] * a; g += data[i + 1] * a; b += data[i + 2] * a; al += a; n++;
      }
      const alpha = al / n, bg = ((Math.floor(x / 6) + Math.floor(y / 6)) % 2) ? 58 : 74, j = (y * dw + x) * 3;
      rgb[j] = Math.round(r / n + bg * (1 - alpha));
      rgb[j + 1] = Math.round(g / n + bg * (1 - alpha));
      rgb[j + 2] = Math.round(b / n + bg * (1 - alpha));
    }
  }
  return { url: encodePngRGB(rgb, dw, dh), width: dw, height: dh };
}

/* ---------- Settings ---------- */

function readSettings() {
  return {
    groupName: safeName($("groupName").value, "Split_Objects"),
    layerPrefix: safeName($("layerPrefix").value, "Object"),
    minAreaPercent: readNumber($("minAreaPercent").value, 0.002, 0, 10),
    padding: Math.round(readNumber($("padding").value, 8, 0, 200)),
    mergeGap: Math.round(readNumber($("tspMergeGap").value, 0, 0, MAX_MERGE_GAP)),
    names: String($("tspNameList").value || "").split(/[,，]/).map(s => s.trim())
  };
}
function detectionSignature(s) { return s.minAreaPercent + "|" + s.mergeGap; }

let sortMode = SORTS.includes(load(STORAGE.sort)) ? load(STORAGE.sort) : "reading";
let outputType = load(STORAGE.output) === "pixel" ? "pixel" : "smart";
let hideSource = load(STORAGE.hideSource) === "true";

function restoreSettings() {
  [["groupName", STORAGE.groupName], ["layerPrefix", STORAGE.layerPrefix], ["minAreaPercent", STORAGE.minAreaPercent],
   ["padding", STORAGE.padding], ["tspMergeGap", STORAGE.mergeGap], ["tspNameList", STORAGE.nameList]].forEach(([id, key]) => {
    const v = load(key);
    if (v !== null) $(id).value = v;
  });
}
function saveSettings() {
  store(STORAGE.groupName, $("groupName").value);
  store(STORAGE.layerPrefix, $("layerPrefix").value);
  store(STORAGE.minAreaPercent, $("minAreaPercent").value);
  store(STORAGE.padding, $("padding").value);
  store(STORAGE.mergeGap, $("tspMergeGap").value);
  store(STORAGE.nameList, $("tspNameList").value);
}

/* ---------- Preview state and rendering ---------- */

let latestAnalysis = null;   // { key, signature, items, objects, initial, selected:Set, image }
let previewRequest = 0, previewTimer = null, analyzing = false, splitting = false;

function selectedKey() {
  try {
    const doc = app.activeDocument, layers = doc && doc.activeLayers;
    return doc && layers && layers.length === 1 ? doc.id + ":" + layers[0].id : "";
  } catch (_) { return ""; }
}
function isVisible() { return root.style.display !== "none"; }

function activeObjects() {
  if (!latestAnalysis) return [];
  return sortObjects(latestAnalysis.objects.filter(o => !o.excluded), latestAnalysis.items, sortMode);
}

function updateRunButton() {
  const button = $("runBtn");
  if (splitting) { button.textContent = "正在拆分…"; button.classList.add("tsp-off"); return; }
  const count = latestAnalysis && latestAnalysis.key === selectedKey() ? activeObjects().length : 0;
  button.classList.toggle("tsp-off", count === 0);
  button.textContent = count ? "拆分 " + count + " 个对象" : (latestAnalysis ? "没有可拆分的对象" : "请先选择透明图层");
}

function updateSelectionBar() {
  const bar = $("tspSelBar");
  if (!latestAnalysis || !latestAnalysis.objects.length) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  const sel = latestAnalysis.objects.filter(o => latestAnalysis.selected.has(o.id));
  const edited = latestAnalysis.objects.length !== latestAnalysis.initial || latestAnalysis.objects.some(o => o.excluded);
  $("tspSelCount").textContent = sel.length ? "已选 " + sel.length + " 个" : "点击预览里的框来选中";
  $("tspMerge").classList.toggle("tsp-off", sel.length < 2);
  $("tspExclude").classList.toggle("tsp-off", sel.length === 0);
  $("tspExclude").textContent = sel.length && sel.every(o => o.excluded) ? "取消排除" : "排除";
  $("tspRestore").classList.toggle("tsp-off", !edited && !sel.length);
}

function renderMarkers() {
  const layer = $("splitPreviewMarkers");
  layer.innerHTML = "";
  if (!latestAnalysis || !latestAnalysis.image) return;
  const { items, image } = latestAnalysis, k = image.scale;
  const order = new Map(activeObjects().map((o, i) => [o.id, i + 1]));
  for (const obj of latestAnalysis.objects) {
    const r = objectRect(obj, items);
    const el = document.createElement("div");
    el.className = "tsp-box" + (obj.excluded ? " tsp-box-excluded" : "") + (latestAnalysis.selected.has(obj.id) ? " tsp-box-selected" : "");
    const w = Math.max(6, (r.maxX - r.minX + 1) * k), h = Math.max(6, (r.maxY - r.minY + 1) * k);
    el.style.left = Math.round(r.minX * k) + "px";
    el.style.top = Math.round(r.minY * k) + "px";
    el.style.width = Math.round(w) + "px";
    el.style.height = Math.round(h) + "px";
    const num = document.createElement("span");
    num.className = "tsp-box-num" + (h < 26 || w < 20 ? " tsp-num-out" : "");
    num.textContent = obj.excluded ? "排除" : String(order.get(obj.id)).padStart(2, "0");
    el.appendChild(num);
    el.title = obj.excluded ? "已排除，点击选中" : "对象 " + order.get(obj.id) + "，点击选中";
    el.addEventListener("click", () => {
      if (latestAnalysis.selected.has(obj.id)) latestAnalysis.selected.delete(obj.id);
      else latestAnalysis.selected.add(obj.id);
      renderMarkers();
    });
    layer.appendChild(el);
  }
  const active = activeObjects().length, excluded = latestAnalysis.objects.length - active;
  $("detectedCount").textContent = active + " 个对象" + (excluded ? " · 排除 " + excluded : "");
  updateSelectionBar();
  updateRunButton();
}

function clearPreview(message) {
  latestAnalysis = null;
  $("splitPreviewImage").removeAttribute("src");
  $("splitPreviewStage").style.display = "none";
  $("splitPreviewMarkers").innerHTML = "";
  $("splitPreviewPlaceholder").style.display = "block";
  $("splitPreviewPlaceholder").textContent = message || "请选择透明图层";
  $("detectedCount").textContent = "未识别";
  $("splitPreviewInfo").textContent = "只读识别，不修改原图层";
  $("splitPreviewInfo").className = "tsp-note";
  updateSelectionBar();
  updateRunButton();
}

function scheduleAnalysis(force) {
  if (!isVisible() || splitting) return;
  if (previewTimer !== null) clearTimeout(previewTimer);
  const request = ++previewRequest;
  previewTimer = setTimeout(() => {
    previewTimer = null;
    if (!isVisible() || splitting) return;
    const key = selectedKey(), signature = detectionSignature(readSettings());
    if (!force && latestAnalysis && latestAnalysis.key === key && latestAnalysis.signature === signature) return;
    if (analyzing) return;
    analyzePreview(request);
  }, 260);
}

async function analyzePreview(request) {
  if (analyzing || splitting) return;
  analyzing = true;
  try {
    const { doc, layer } = getCurrentLayer();
    const key = doc.id + ":" + layer.id;
    refreshLayerStatus();
    $("detectedCount").textContent = "识别中…";
    $("splitPreviewInfo").textContent = "正在读取透明像素";
    $("splitPreviewInfo").className = "tsp-note";
    // getPixels may need a modal scope; this transaction only reads.
    const pixels = await core.executeAsModal(async () => await readTransparentPixels(doc, layer), { commandName: "分析透明对象预览" });
    if (request !== previewRequest || key !== selectedKey()) return;
    const settings = readSettings();
    const minArea = Math.max(1, Math.floor(pixels.width * pixels.height * settings.minAreaPercent / 100));
    const result = buildConnectedComponents(pixels.data, pixels.width, pixels.height, pixels.components, minArea, settings.mergeGap);

    const holder = $("splitPreview");
    const maxW = Math.max(100, (holder.clientWidth || 340) - 14), maxH = Math.max(80, (holder.clientHeight || 180) - 14);
    const k = Math.min(maxW / pixels.width, maxH / pixels.height, 4);
    const preview = previewUrl(pixels.data, pixels.width, pixels.height, k);
    if (request !== previewRequest || key !== selectedKey()) return;

    const img = $("splitPreviewImage");
    img.src = preview.url;
    img.style.width = preview.width + "px";
    img.style.height = preview.height + "px";
    $("splitPreviewStage").style.width = preview.width + "px";
    $("splitPreviewStage").style.height = preview.height + "px";
    $("splitPreviewStage").style.display = "block";
    $("splitPreviewPlaceholder").style.display = "none";

    const objects = makeObjects(result.items);
    latestAnalysis = {
      key, signature: detectionSignature(settings), items: result.items, objects,
      initial: objects.length, selected: new Set(),
      image: { scale: preview.width / pixels.width }
    };
    renderMarkers();
    const n = result.items.length;
    $("splitPreviewInfo").textContent = n === 0 ? "没有识别到独立元素，可调小「最小面积」"
      : n === 1 ? (result.hasTransparentGap ? "只识别到一个整体，可调小「合并间距」" : "图层没有透明间隔，只能识别为一个整体")
      : "已标出 " + n + " 个区域 · 点击框可合并或排除 · 原图未修改";
  } catch (e) {
    clearPreview("暂时无法预览该图层");
    $("splitPreviewInfo").textContent = formatError(e);
    $("splitPreviewInfo").className = "tsp-note tsp-err";
    refreshLayerStatus();
  } finally {
    analyzing = false;
    if (request !== previewRequest && isVisible() && !splitting) scheduleAnalysis(false);
  }
}

/* ---------- Manual merge / exclude ---------- */

function mergeSelected() {
  if (!latestAnalysis) return;
  const sel = latestAnalysis.objects.filter(o => latestAnalysis.selected.has(o.id));
  if (sel.length < 2) { setMessage("至少选中 2 个框才能合并。", "error"); return; }
  const merged = { id: nextObjectId++, parts: [].concat(...sel.map(o => o.parts)), excluded: false };
  const firstIndex = latestAnalysis.objects.indexOf(sel[0]);
  latestAnalysis.objects = latestAnalysis.objects.filter(o => !latestAnalysis.selected.has(o.id));
  latestAnalysis.objects.splice(Math.min(firstIndex, latestAnalysis.objects.length), 0, merged);
  latestAnalysis.selected.clear();
  renderMarkers();
  setMessage("已把 " + sel.length + " 块合并成 1 个对象。", "muted");
}
function excludeSelected() {
  if (!latestAnalysis) return;
  const sel = latestAnalysis.objects.filter(o => latestAnalysis.selected.has(o.id));
  if (!sel.length) return;
  const include = sel.every(o => o.excluded);
  sel.forEach(o => { o.excluded = !include; });
  latestAnalysis.selected.clear();
  renderMarkers();
}
function restoreObjects() {
  if (!latestAnalysis) return;
  latestAnalysis.objects = makeObjects(latestAnalysis.items);
  latestAnalysis.initial = latestAnalysis.objects.length;
  latestAnalysis.selected.clear();
  renderMarkers();
}

/* ---------- Split ---------- */

function sameItems(a, b) {
  return a.length === b.length && a.every((x, i) => x.minX === b[i].minX && x.minY === b[i].minY && x.maxX === b[i].maxX && x.maxY === b[i].maxY && x.area === b[i].area);
}

async function splitObjects() {
  if (splitting || analyzing) return;
  const key = selectedKey();
  if (!latestAnalysis || latestAnalysis.key !== key) {
    setMessage("请先确认当前图层的识别预览，再点击拆分。", "error");
    scheduleAnalysis(true);
    return;
  }
  const settings = readSettings();
  if (latestAnalysis.signature !== detectionSignature(settings)) { setMessage("识别参数已改变，正在重新识别，请稍后再拆分。", "error"); scheduleAnalysis(true); return; }
  const ordered = activeObjects();
  if (!ordered.length) { setMessage("没有可拆分的对象（可能全部被排除了）。", "error"); return; }
  saveSettings();
  splitting = true;
  updateRunButton();

  let stage = "读取当前图层", count = 0, noGap = false;
  try {
    const { doc, layer: sourceLayer } = getCurrentLayer();
    const sourceName = sourceLayer.name, sourceVisible = sourceLayer.visible;
    const style = {};
    ["opacity", "fillOpacity", "blendMode"].forEach(p => { try { style[p] = sourceLayer[p]; } catch (_) {} });
    const analysis = latestAnalysis;
    setMessage("正在拆分…", "muted");

    await core.executeAsModal(async (ctx) => {
      // One history step; any failure rolls everything back.
      const token = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "透明对象拆分" });
      let committed = false;
      try {
        app.activeDocument = doc;
        stage = "读取原图透明像素";
        ctx.reportProgress({ value: 0.08, commandName: stage });
        const pixels = await readTransparentPixels(doc, sourceLayer);
        stage = "核对识别结果";
        const minArea = Math.max(1, Math.floor(pixels.width * pixels.height * settings.minAreaPercent / 100));
        const result = buildConnectedComponents(pixels.data, pixels.width, pixels.height, pixels.components, minArea, settings.mergeGap);
        noGap = !result.hasTransparentGap;
        if (!sameItems(result.items, analysis.items)) throw new Error("图层内容在识别后发生了变化，请点「重新识别」后再拆分。");

        const bx = Number(pixels.sourceBounds && pixels.sourceBounds.left) || 0, by = Number(pixels.sourceBounds && pixels.sourceBounds.top) || 0;
        const rects = analysis.objects.map(o => ({ o, r: objectRect(o, result.items) }));
        stage = "创建结果组";
        const group = await doc.createLayerGroup({ name: settings.groupName });
        count = ordered.length;

        // Create in reverse so the Layers panel reads 01, 02, 03… from top to bottom.
        for (let i = ordered.length - 1; i >= 0; i--) {
          const obj = ordered[i];
          const name = settings.names[i] || `${settings.layerPrefix}_${String(i + 1).padStart(2, "0")}`;
          stage = "拆分 " + name;
          ctx.reportProgress({ value: 0.15 + 0.8 * (ordered.length - i) / ordered.length, commandName: stage });
          const rect = rects.find(x => x.o === obj).r;
          const pad = safePadding(rect, rects.filter(x => x.o !== obj).map(x => x.r), settings.padding);
          const piece = objectPixels(pixels, result.labels, obj, rect, pad);
          if (!piece) throw new Error(name + " 的像素区域为空");
          let out = await doc.createPixelLayer({ name });
          const imageData = await imaging.createImageDataFromBuffer(piece.data, { width: piece.width, height: piece.height, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
          try {
            await imaging.putPixels({ documentID: doc.id, layerID: out.id, imageData, targetBounds: { left: Math.round(bx + piece.left), top: Math.round(by + piece.top) }, replace: true, commandName: "写入拆分对象像素" });
          } finally {
            imageData.dispose();
          }
          if (outputType === "smart") {
            await selectLayerById(out.id);
            await convertActiveLayerToSmartObject();
            const active = doc.activeLayers || [];
            if (active.length !== 1) throw new Error(`${name} 转智能对象后无法取得结果层。`);
            out = active[0];
          }
          out.name = name;
          // Keep the source layer's look (opacity, fill, blend mode).
          for (const p of ["opacity", "fillOpacity", "blendMode"]) { if (style[p] !== undefined) { try { out[p] = style[p]; } catch (_) {} } }
          out.move(group, constants.ElementPlacement.PLACEINSIDE);
        }
        try { await doc.selection.deselect(); } catch (_) {}

        stage = "检查原图层";
        if (sourceLayer.name !== sourceName) throw new Error("保护检查失败：原始图层名称被意外修改。");
        if (sourceLayer.visible !== sourceVisible) throw new Error("保护检查失败：原始图层可见状态被意外修改。");
        if (hideSource) sourceLayer.visible = false;
        await selectLayerById(group.id);
        committed = true;
      } finally {
        await ctx.hostControl.resumeHistory(token, committed);
      }
    }, { commandName: "透明对象拆分" });

    setMessage(`✓ 已拆出 ${count} 个${outputType === "smart" ? "智能对象" : "像素图层"}${hideSource ? "，原图层已隐藏" : "，原图层保持不变"}。一次 Ctrl+Z 可撤销。${noGap ? " 当前图层没有明显透明间隔。" : ""}`, "success");
  } catch (err) {
    setMessage(`失败[${stage}]：${formatError(err)}。已自动撤回本次改动。`, "error");
    console.error(err);
  } finally {
    splitting = false;
    latestAnalysis = null;
    refreshLayerStatus();
    scheduleAnalysis(true);
    updateRunButton();
  }
}

/* ---------- Events ---------- */

function onActivate(el, handler) {
  el.addEventListener("click", handler);
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } });
}
function setSegment(selector, attr, value) {
  root.querySelectorAll(selector).forEach(el => {
    const on = el.getAttribute(attr) === value;
    el.classList.toggle("tsp-selected", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  });
}
function setOutputType(mode) {
  outputType = mode === "pixel" ? "pixel" : "smart";
  store(STORAGE.output, outputType);
  setSegment(".tsp-output-option", "data-output", outputType);
}
function setSort(mode) {
  sortMode = SORTS.includes(mode) ? mode : "reading";
  store(STORAGE.sort, sortMode);
  setSegment(".tsp-sort-option", "data-sort", sortMode);
  renderMarkers();
}
function setHideSource(on) {
  hideSource = !!on;
  store(STORAGE.hideSource, hideSource);
  $("tspHideSource").setAttribute("aria-checked", hideSource ? "true" : "false");
}
function nudge(id, e, step) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const current = Number($(id).value);
  const delta = (e.shiftKey ? 10 : 1) * step * (e.key === "ArrowUp" ? 1 : -1);
  const next = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);
  $(id).value = String(Math.round(next * 1000) / 1000);
  saveSettings();
  if (id !== "padding") scheduleAnalysis(false);
}

function wireEvents() {
  onActivate($("refreshLayerBtn"), () => { refreshLayerStatus(); scheduleAnalysis(true); });
  onActivate($("runBtn"), splitObjects);
  onActivate($("tspMerge"), mergeSelected);
  onActivate($("tspExclude"), excludeSelected);
  onActivate($("tspRestore"), restoreObjects);
  onActivate($("tspHideSource"), () => setHideSource(!hideSource));
  root.querySelectorAll(".tsp-output-option").forEach(el => onActivate(el, () => setOutputType(el.getAttribute("data-output"))));
  root.querySelectorAll(".tsp-sort-option").forEach(el => onActivate(el, () => setSort(el.getAttribute("data-sort"))));
  // Detection settings: re-analyse (manual merges/excludes are reset by a new analysis).
  [["tspMergeGap", 1], ["minAreaPercent", 0.001]].forEach(([id, step]) => {
    $(id).addEventListener("change", () => { saveSettings(); scheduleAnalysis(false); });
    $(id).addEventListener("keydown", e => nudge(id, e, step));
  });
  $("padding").addEventListener("keydown", e => nudge("padding", e, 1));
  ["groupName", "layerPrefix", "padding", "tspNameList"].forEach(id => $(id).addEventListener("change", saveSettings));
}

function init() {
  restoreSettings();
  wireEvents();
  refreshLayerStatus();
  setOutputType(outputType);
  setSort(sortMode);
  setHideSource(hideSource);
  clearPreview("选择透明图层后自动识别");
  root.__transparentSplitActivate = function () {
    refreshLayerStatus();
    scheduleAnalysis(false);
  };
  try {
    action.addNotificationListener(["select", "open", "close"], (eventName, descriptor) => {
      if (!isVisible() || splitting) return;
      if (eventName === "select") {
        const targets = descriptor && descriptor._target;
        if (Array.isArray(targets) && !targets.some(x => x && (x._ref === "layer" || x._ref === "document"))) return;
      }
      scheduleAnalysis(false);
    });
  } catch (e) { console.warn("[Transparent Split] selection listener unavailable", e); }
  scheduleAnalysis(true);
}

init();

};

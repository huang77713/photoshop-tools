/* Sprite Font Composer (图片数字排版) - Photoshop UXP.
 * Glyph detection, library import and atlas reading are the original algorithms.
 * v4: glyph pixels cached after the first atlas read (no atlas reopen per generate),
 * single composed checkerboard preview (no 60-glyph limit), one-step undo,
 * placement on canvas / selection / selected layer with optional replace,
 * output as separate layers / merged layer / smart object, monospaced digits,
 * auto-saved mapping and a two-step delete confirmation. */
module.exports = function mountSpriteFont(root) {
const { app, core, imaging, constants, action } = require("photoshop");
const { storage } = require("uxp");

const fs = storage.localFileSystem;
const STORAGE_KEY = "spriteFontComposer.libraries.v1";
const SELECTED_KEY = "spriteFontComposer.selectedLibrary.v1";
const PREF = { place: "spriteFontComposer.v4.place", output: "spriteFontComposer.v4.output", replace: "spriteFontComposer.v4.replace" };
const PLACES = ["canvas", "selection", "layer"];
const OUTPUTS = ["layers", "merged", "smart"];
const PLACE_NOTE = {
  canvas: "放在当前画布上，上下居中。",
  selection: "放进当前选区里，上下居中。请先用选框工具画一个选区。",
  layer: "对齐到选中的图层，上下居中。"
};
const OUTPUT_NOTE = {
  layers: "每个字符一个图层，自动放进一个组。",
  merged: "所有字符合成一个像素图层。",
  smart: "合成一个图层后转成智能对象，以后缩放不损失画质。"
};

function readPref(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (_) { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, String(value)); } catch (_) {} }

let libraries = loadLibraries();
let selectedLibraryId = localStorage.getItem(SELECTED_KEY) || (libraries[0] ? libraries[0].id : "");
const glyphCache = new Map();   // library id -> { token, glyphs:[{rgba,width,height,shiftX,shiftY,colorProfile,url}] }
const glyphLoading = new Map(); // library id -> Promise
let placeMode = PLACES.includes(readPref(PREF.place, "canvas")) ? readPref(PREF.place, "canvas") : "canvas";
let outputMode = OUTPUTS.includes(readPref(PREF.output, "layers")) ? readPref(PREF.output, "layers") : "layers";
let replaceTarget = readPref(PREF.replace, "false") === "true";
let generating = false;
let previewSerial = 0;
let previewTimer = null;
let deleteArmed = null;

function $(id) {
  return root.querySelector("#" + id);
}

function loadLibraries() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn("Failed to load libraries", e);
    return [];
  }
}

function saveLibraries() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(libraries));
}

function uid() {
  return "font_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function currentLibrary() {
  return libraries.find((item) => item.id === selectedLibraryId) || null;
}

function setStatus(message, type = "muted") {
  const el = $("status");
  el.textContent = message;
  el.className = "status sf-status " + type;
}

function errorText(e) {
  return (e && e.message) || String(e);
}

function stripExtension(name) {
  return String(name || "新字库").replace(/\.[^.]+$/, "");
}

function guessMapping(count) {
  if (count === 10) return "0123456789";
  if (count === 13) return "₹,.0123456789";
  return "";
}

function getMappingChars(lib) {
  return Array.from((lib && lib.mapping) || "");
}

/* ---------- Library list and settings ---------- */

function renderLibraries() {
  const select = $("librarySelect");
  select.innerHTML = "";

  if (!libraries.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "暂无字库";
    select.appendChild(option);
    select.disabled = true;
    selectedLibraryId = "";
  } else {
    select.disabled = false;
    if (!libraries.some((item) => item.id === selectedLibraryId)) {
      selectedLibraryId = libraries[0].id;
    }
    libraries.forEach((lib) => {
      const option = document.createElement("option");
      option.value = lib.id;
      option.textContent = lib.name || lib.fileName || "未命名字库";
      option.selected = lib.id === selectedLibraryId;
      select.appendChild(option);
    });
  }

  localStorage.setItem(SELECTED_KEY, selectedLibraryId || "");
  renderLibraryEditor();
  readPreviewPreferences(currentLibrary());
  schedulePreview();
}

function renderLibraryMeta() {
  const lib = currentLibrary(), meta = $("sfLibraryMeta");
  if (!lib) { meta.textContent = "尚未导入字库，点击「导入」选择一张透明 PNG 字库图。"; meta.className = "sf-muted sf-library-meta"; return; }
  const chars = getMappingChars(lib);
  if (chars.length !== lib.boxes.length) {
    meta.textContent = "识别 " + lib.boxes.length + " 个字符，映射填了 " + chars.length + " 个，请在「设置」里核对";
    meta.className = "sf-library-meta sf-status warning";
  } else {
    meta.textContent = lib.boxes.length + " 个字符 · " + chars.join("");
    meta.className = "sf-muted sf-library-meta";
  }
}

function setManagerOpen(open) {
  $("sfManager").style.display = open ? "block" : "none";
  $("btnManage").textContent = open ? "收起" : "设置";
}

function renderLibraryEditor() {
  const lib = currentLibrary();
  const preview = $("glyphPreview");
  renderLibraryMeta();
  $("sfMono").setAttribute("aria-pressed", lib && lib.mono ? "true" : "false");

  if (!lib) {
    $("libraryName").value = "";
    $("mappingInput").value = "";
    $("glyphCount").textContent = "尚未导入字库";
    preview.className = "glyph-preview empty";
    preview.textContent = "导入一张透明 PNG 字库后，这里会显示自动拆分结果。";
    $("btnDelete").classList.add("sf-off");
    return;
  }

  $("btnDelete").classList.remove("sf-off");
  $("libraryName").value = lib.name || "";
  $("mappingInput").value = lib.mapping || "";
  $("glyphCount").textContent = `${lib.boxes.length} 个字符 · ${lib.sourceWidth}×${lib.sourceHeight}px`;

  preview.className = "glyph-preview";
  preview.innerHTML = "";
  const chars = getMappingChars(lib);

  lib.boxes.forEach((box, index) => {
    const chip = document.createElement("div");
    chip.className = "glyph-chip";
    const image = document.createElement("img");
    image.className = "sf-glyph-image";
    image.setAttribute("alt", "字形 " + (index + 1));
    image.style.display = "none";
    chip.appendChild(image);
    const charEl = document.createElement("div");
    charEl.className = "glyph-char";
    charEl.textContent = chars[index] || "?";
    const indexEl = document.createElement("div");
    indexEl.className = "glyph-index";
    indexEl.textContent = `#${index + 1}`;
    const sizeEl = document.createElement("div");
    sizeEl.className = "glyph-size";
    sizeEl.textContent = `${box.right - box.left}×${box.bottom - box.top}`;
    chip.appendChild(charEl);
    chip.appendChild(indexEl);
    chip.appendChild(sizeEl);
    preview.appendChild(chip);
  });
  renderGlyphImageChips();
}

function refreshMappedGlyphLabels() {
  const chars = getMappingChars(currentLibrary());
  const chips = $("glyphPreview").querySelectorAll(".glyph-char");
  for (let i = 0; i < chips.length; i++) chips[i].textContent = chars[i] || "?";
}

function renderGlyphImageChips() {
  const lib = currentLibrary(); if (!lib) return;
  const cache = glyphCache.get(lib.id);
  if (!cache) return;
  const images = $("glyphPreview").querySelectorAll(".sf-glyph-image");
  for (let i = 0; i < images.length; i++) {
    const entry = cache.glyphs[i];
    if (entry && entry.url) { images[i].src = entry.url; images[i].style.display = "block"; }
  }
}

function readPreviewPreferences(lib) {
  if (!lib) return;
  $("spacingInput").value = Number.isFinite(Number(lib.spacing)) ? String(lib.spacing) : "0";
  $("scaleInput").value = Number.isFinite(Number(lib.previewScale)) ? String(lib.previewScale) : "100";
  const align = lib.align === "left" || lib.align === "right" ? lib.align : "center";
  const radio = root.querySelector('input[name="sfAlign"][value="' + align + '"]');
  if (radio) radio.checked = true;
  updateAlignButtons();
}

function savePreviewSettings(lib) {
  if (!lib) return;
  const spacing = Number($("spacingInput").value);
  const scale = Number($("scaleInput").value);
  lib.spacing = Number.isFinite(spacing) ? spacing : 0;
  lib.previewScale = Number.isFinite(scale) ? scale : 100;
  const radio = root.querySelector('input[name="sfAlign"]:checked');
  lib.align = radio ? radio.value : "center";
  saveLibraries();
}

function updateAlignButtons() {
  const selected = root.querySelector('input[name="sfAlign"]:checked');
  const value = selected ? selected.value : "center";
  root.querySelectorAll(".sf-align-option").forEach(item => {
    const control = item.querySelector("input");
    item.classList.toggle("selected", !!control && control.value === value);
  });
}

function currentAlign() {
  const el = root.querySelector('input[name="sfAlign"]:checked');
  return el ? el.value : "center";
}

/* ---------- Original detection / import / atlas reading ---------- */

function sampleBackground(data, width, height, components) {
  const points = [
    [0, 0],
    [Math.max(0, width - 1), 0],
    [0, Math.max(0, height - 1)],
    [Math.max(0, width - 1), Math.max(0, height - 1)]
  ];
  let r = 0, g = 0, b = 0;
  points.forEach(([x, y]) => {
    const i = (y * width + x) * components;
    r += data[i] || 0;
    g += data[i + 1] || 0;
    b += data[i + 2] || 0;
  });
  return [r / points.length, g / points.length, b / points.length];
}

function createForegroundMask(data, width, height, components, hasAlpha) {
  const mask = new Uint8Array(width * height);

  if (hasAlpha && components >= 4) {
    for (let p = 0, i = 0; p < mask.length; p++, i += components) {
      mask[p] = data[i + 3] > 18 ? 1 : 0;
    }
    return mask;
  }

  const bg = sampleBackground(data, width, height, components);
  const thresholdSq = 28 * 28;
  for (let p = 0, i = 0; p < mask.length; p++, i += components) {
    const dr = (data[i] || 0) - bg[0];
    const dg = (data[i + 1] || 0) - bg[1];
    const db = (data[i + 2] || 0) - bg[2];
    mask[p] = (dr * dr + dg * dg + db * db) > thresholdSq ? 1 : 0;
  }
  return mask;
}

function occupiedRuns(flags, mergeGap = 0) {
  const runs = [];
  let start = -1;
  let lastOn = -1;

  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) {
      if (start < 0) start = i;
      lastOn = i;
    } else if (start >= 0 && i - lastOn > mergeGap) {
      runs.push([start, lastOn + 1]);
      start = -1;
      lastOn = -1;
    }
  }

  if (start >= 0) runs.push([start, lastOn + 1]);
  return runs;
}

function detectGlyphBoxes(data, width, height, components, hasAlpha, originX = 0, originY = 0) {
  const mask = createForegroundMask(data, width, height, components, hasAlpha);
  const rowFlags = new Uint8Array(height);

  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[offset + x]) {
        rowFlags[y] = 1;
        break;
      }
    }
  }

  const rowRuns = occupiedRuns(rowFlags, 1);
  const boxes = [];

  rowRuns.forEach(([rowTop, rowBottom], rowIndex) => {
    const colFlags = new Uint8Array(width);

    for (let x = 0; x < width; x++) {
      for (let y = rowTop; y < rowBottom; y++) {
        if (mask[y * width + x]) {
          colFlags[x] = 1;
          break;
        }
      }
    }

    const colRuns = occupiedRuns(colFlags, 0);
    colRuns.forEach(([left, right]) => {
      let top = rowBottom;
      let bottom = rowTop;
      let area = 0;

      for (let y = rowTop; y < rowBottom; y++) {
        for (let x = left; x < right; x++) {
          if (mask[y * width + x]) {
            area++;
            if (y < top) top = y;
            if (y + 1 > bottom) bottom = y + 1;
          }
        }
      }

      if (area < 2 || bottom <= top || right <= left) return;

      boxes.push({
        left: left + originX,
        top: top + originY,
        right: right + originX,
        bottom: bottom + originY,
        rowTop: rowTop + originY,
        rowBottom: rowBottom + originY,
        rowIndex
      });
    });
  });

  return boxes;
}

async function analyzeAtlasEntry(entry) {
  let result = null;

  await core.executeAsModal(async () => {
    const sourceDoc = await app.open(entry);
    try {
      const pixels = await imaging.getPixels({
        documentID: sourceDoc.id,
        sourceBounds: { left: 0, top: 0, width: sourceDoc.width, height: sourceDoc.height },
        colorSpace: "RGB",
        componentSize: 8,
        applyAlpha: false
      });

      const imageData = pixels.imageData;
      const raw = await imageData.getData({ chunky: true });
      const data = new Uint8Array(raw);
      const originX = pixels.sourceBounds ? pixels.sourceBounds.left : 0;
      const originY = pixels.sourceBounds ? pixels.sourceBounds.top : 0;

      const boxes = detectGlyphBoxes(
        data,
        imageData.width,
        imageData.height,
        imageData.components,
        imageData.hasAlpha,
        originX,
        originY
      );

      result = {
        boxes,
        sourceWidth: sourceDoc.width,
        sourceHeight: sourceDoc.height
      };

      imageData.dispose();
    } finally {
      sourceDoc.closeWithoutSaving();
    }
  }, { commandName: "分析图片字库" });

  return result;
}

async function importLibrary() {
  try {
    const entry = await fs.getFileForOpening({
      allowMultiple: false,
      types: ["png", "jpg", "jpeg", "webp", "tif", "tiff"]
    });
    if (!entry) return;

    setStatus("正在分析图片中的字符…");
    const analysis = await analyzeAtlasEntry(entry);

    if (!analysis || !analysis.boxes.length) {
      setStatus("没有识别到可拆分字符。建议使用透明 PNG，或确保字符之间有明显空隙。", "error");
      return;
    }

    const token = await fs.createPersistentToken(entry);
    const mapping = guessMapping(analysis.boxes.length);
    const lib = {
      id: uid(),
      name: stripExtension(entry.name),
      fileName: entry.name,
      token,
      mapping,
      boxes: analysis.boxes,
      sourceWidth: analysis.sourceWidth,
      sourceHeight: analysis.sourceHeight,
      createdAt: new Date().toISOString()
    };

    libraries.unshift(lib);
    selectedLibraryId = lib.id;
    saveLibraries();
    renderLibraries();
    setManagerOpen(true);
    if (mapping) {
      setStatus(`已识别 ${analysis.boxes.length} 个字符，并自动填写了字符映射，请核对是否正确。`, "success");
    } else {
      setStatus(`已识别 ${analysis.boxes.length} 个字符。请在“字符映射”里按顺序填入对应字符。`, "warning");
    }
  } catch (e) {
    console.error(e);
    setStatus("导入失败：" + (e.message || String(e)), "error");
  }
}

async function deleteLibrary() {
  const lib = currentLibrary();
  if (!lib) return;
  libraries = libraries.filter((item) => item.id !== lib.id);
  selectedLibraryId = libraries[0] ? libraries[0].id : "";
  saveLibraries();
  glyphCache.delete(lib.id);
  renderLibraries();
  setStatus("字库已从插件列表中删除（不会删除你的原图片）。", "success");
}

function buildCharMap(lib) {
  const chars = getMappingChars(lib);
  if (chars.length !== lib.boxes.length) {
    throw new Error(`字符映射数量不一致：映射 ${chars.length} 个，图片 ${lib.boxes.length} 个。`);
  }

  const map = new Map();
  chars.forEach((char, index) => {
    if (map.has(char)) throw new Error(`字符映射里出现了重复字符：“${char}”。`);
    map.set(char, lib.boxes[index]);
  });
  return map;
}

function getOpenDocumentById(id) {
  for (let i = 0; i < app.documents.length; i++) {
    if (app.documents[i].id === id) return app.documents[i];
  }
  return null;
}

async function readGlyphFromAtlas(documentID, box) {
  const pixels = await imaging.getPixels({
    documentID,
    sourceBounds: {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom
    },
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: false
  });

  const imageData = pixels.imageData;
  const raw = await imageData.getData({ chunky: true });
  const sourceBounds = pixels.sourceBounds || box;
  const glyph = {
    data: new Uint8Array(raw),
    width: imageData.width,
    height: imageData.height,
    components: imageData.components,
    colorSpace: imageData.colorSpace || "RGB",
    colorProfile: imageData.colorProfile || "",
    shiftX: sourceBounds.left - box.left,
    shiftY: sourceBounds.top - box.top
  };
  imageData.dispose();
  return glyph;
}


/* ---------- Glyph cache (read the atlas once per library) ---------- */

function toRGBA(glyph) {
  if (glyph.components === 4) return glyph.data;
  const n = glyph.width * glyph.height, out = new Uint8Array(n * 4), c = glyph.components;
  for (let i = 0; i < n; i++) {
    out[i * 4] = glyph.data[i * c] || 0;
    out[i * 4 + 1] = glyph.data[i * c + 1] || 0;
    out[i * 4 + 2] = glyph.data[i * c + 2] || 0;
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Lossless PNG preview encoder (stored deflate blocks). The Photoshop JPEG encoder blurs
// small glyphs and adds colour noise, so previews are encoded here as PNG instead.
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
  const total = 8 + chunks.reduce((sum, c) => sum + 12 + c[1].length, 0);
  const png = new Uint8Array(total), view = new DataView(png.buffer);
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

// Resample RGBA to the on-screen size (nearest neighbour when enlarging keeps pixels sharp,
// area average when shrinking), then draw over a checkerboard (tile>0) or the flat panel colour.
async function rgbaToPreviewUrl(rgba, w, h, scale, tile) {
  const k = scale > 0 ? scale : 1;
  const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
  const rgb = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.min(h - 1, Math.floor(y / k)), sy1 = k < 1 ? Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) / k))) : sy0 + 1;
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.min(w - 1, Math.floor(x / k)), sx1 = k < 1 ? Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) / k))) : sx0 + 1;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * w + sx) * 4, al = rgba[i + 3] / 255;
        r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += al; n++;
      }
      const alpha = a / n;
      const bg = tile > 0 ? (((Math.floor(x / tile) + Math.floor(y / tile)) % 2) ? 58 : 74) : 43;
      const j = (y * dw + x) * 3;
      rgb[j] = Math.round(r / n + bg * (1 - alpha));
      rgb[j + 1] = Math.round(g / n + bg * (1 - alpha));
      rgb[j + 2] = Math.round(b / n + bg * (1 - alpha));
    }
  }
  return encodePngRGB(rgb, dw, dh);
}

function ensureGlyphs(lib) {
  const cached = glyphCache.get(lib.id);
  if (cached && cached.token === lib.token) return Promise.resolve(cached);
  if (glyphLoading.has(lib.id)) return glyphLoading.get(lib.id);
  const job = (async () => {
    let entry;
    try { entry = await fs.getEntryForPersistentToken(lib.token); }
    catch (e) { throw new Error("原字库图片已移动、删除或权限失效，请重新导入这张字库图片。"); }
    const raw = [];
    await core.executeAsModal(async () => {
      const atlas = await app.open(entry);
      try {
        for (const box of lib.boxes) raw.push(await readGlyphFromAtlas(atlas.id, box));
      } finally {
        atlas.closeWithoutSaving();
      }
    }, { commandName: "读取图片字库" });
    const glyphs = [];
    for (const g of raw) {
      const rgba = toRGBA(g);
      let url = "";
      try { url = await rgbaToPreviewUrl(rgba, g.width, g.height, Math.min(1, 44 / g.width, 40 / g.height), 0); } catch (_) {}
      glyphs.push({ rgba, width: g.width, height: g.height, shiftX: g.shiftX, shiftY: g.shiftY, colorProfile: g.colorProfile, url });
    }
    const result = { token: lib.token, glyphs };
    glyphCache.set(lib.id, result);
    return result;
  })();
  glyphLoading.set(lib.id, job);
  job.then(() => {
    glyphLoading.delete(lib.id);
    const current = currentLibrary();
    if (current && current.id === lib.id) { renderGlyphImageChips(); schedulePreview(); }
  }, () => glyphLoading.delete(lib.id));
  return job;
}

/* ---------- Layout (shared by preview and generation) ---------- */

function numberInput(id, fallback) {
  const v = Number($(id).value);
  return Number.isFinite(v) ? v : fallback;
}
function currentSpacing() { return Math.round(numberInput("spacingInput", 0)); }
function currentScale() { return Math.max(10, Math.min(500, numberInput("scaleInput", 100))); }
const isDigit = ch => /^[0-9]$/.test(ch);

// Returns pieces positioned in an unscaled layout box. The box height follows the atlas
// rows (as in the original generator), so different numbers keep the same baseline.
function computeLayout(lib, text, glyphs) {
  const chars = Array.from(text);
  const indexOf = new Map();
  getMappingChars(lib).forEach((ch, i) => { if (!indexOf.has(ch)) indexOf.set(ch, i); });
  const unsupported = Array.from(new Set(chars.filter(ch => ch !== " " && !indexOf.has(ch))));
  if (unsupported.length) return { unsupported, pieces: [] };
  const used = chars.filter(ch => ch !== " ").map(ch => indexOf.get(ch));
  if (!used.length) return { unsupported: [], pieces: [], empty: true };

  const widthOf = i => lib.boxes[i].right - lib.boxes[i].left;
  let digitCell = 0;
  if (lib.mono) indexOf.forEach((i, ch) => { if (isDigit(ch)) digitCell = Math.max(digitCell, widthOf(i)); });
  const average = used.reduce((sum, i) => sum + widthOf(i), 0) / used.length;
  const spaceWidth = Math.max(1, Math.round((digitCell || average) * 0.5));
  const gap = currentSpacing();

  let cursor = 0;
  const pieces = [];
  chars.forEach((ch, k) => {
    if (ch === " ") cursor += spaceWidth;
    else {
      const i = indexOf.get(ch), box = lib.boxes[i], w = widthOf(i);
      const cell = digitCell && isDigit(ch) ? digitCell : w;
      const g = glyphs && glyphs[i];
      pieces.push({
        ch, index: i,
        x: cursor + Math.round((cell - w) / 2) + (g ? g.shiftX : 0),
        y: (box.top - box.rowTop) + (g ? g.shiftY : 0),
        w: g ? g.width : w,
        h: g ? g.height : box.bottom - box.top
      });
      cursor += cell;
    }
    if (k < chars.length - 1) cursor += gap;
  });
  const rowHeight = Math.max(1, ...used.map(i => lib.boxes[i].rowBottom - lib.boxes[i].rowTop));
  let minX = 0, maxX = Math.max(1, cursor), minY = 0, maxY = rowHeight;
  pieces.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x + p.w); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y + p.h); });
  pieces.forEach(p => { p.x -= minX; p.y -= minY; });
  return { unsupported: [], pieces, width: Math.max(1, Math.round(maxX - minX)), height: Math.max(1, Math.round(maxY - minY)) };
}

// Alpha-composite all pieces into one RGBA buffer (used by the preview and the merged output).
function composeRGBA(layout, glyphs) {
  const W = layout.width, H = layout.height, out = new Uint8Array(W * H * 4);
  for (const p of layout.pieces) {
    const g = glyphs[p.index], src = g.rgba;
    for (let y = 0; y < g.height; y++) {
      const ty = p.y + y; if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < g.width; x++) {
        const tx = p.x + x; if (tx < 0 || tx >= W) continue;
        const si = (y * g.width + x) * 4, sa = src[si + 3] / 255;
        if (sa <= 0) continue;
        const di = (ty * W + tx) * 4, da = out[di + 3] / 255, oa = sa + da * (1 - sa);
        for (let c = 0; c < 3; c++) out[di + c] = Math.round((src[si + c] * sa + out[di + c] * da * (1 - sa)) / oa);
        out[di + 3] = Math.round(oa * 255);
      }
    }
  }
  return out;
}

/* ---------- Preview ---------- */

function schedulePreview() {
  if (previewTimer !== null) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { previewTimer = null; renderPreview(); }, 60);
}

async function renderPreview() {
  const serial = ++previewSerial;
  const img = $("sfPreviewImage"), placeholder = $("sfPreviewPlaceholder"), dims = $("previewDimensions"), msg = $("previewMessage");
  const show = text => { img.style.display = "none"; placeholder.style.display = "block"; placeholder.textContent = text; };
  dims.textContent = "";
  updateGenerateLabel();
  const lib = currentLibrary(), text = $("textInput").value;
  if (!lib) { show("请先导入字库"); msg.textContent = ""; return; }
  if (!text) { show("输入内容后预览"); msg.textContent = ""; return; }
  const mapping = getMappingChars(lib);
  if (mapping.length !== lib.boxes.length) {
    show("请先核对字库字符映射");
    msg.textContent = "识别了 " + lib.boxes.length + " 个字符，映射有 " + mapping.length + " 个";
    return;
  }
  const cache = glyphCache.get(lib.id);
  if (!cache || cache.token !== lib.token) {
    show("正在读取字库图片…"); msg.textContent = "";
    ensureGlyphs(lib).catch(e => {
      const current = currentLibrary();
      if (current && current.id === lib.id) { show("字库图片读取失败"); msg.textContent = errorText(e); }
    });
    return;
  }
  const layout = computeLayout(lib, text, cache.glyphs);
  if (layout.unsupported.length) { show("当前字库缺少字符"); msg.textContent = "缺少：" + layout.unsupported.join(" "); return; }
  if (layout.empty) { show("没有可显示的字符"); msg.textContent = ""; return; }
  const zoom = currentScale() / 100;
  dims.textContent = Math.max(1, Math.round(layout.width * zoom)) + " × " + Math.max(1, Math.round(layout.height * zoom)) + " px";
  const holder = $("composedPreview");
  const maxW = Math.max(60, holder.clientWidth - 14), maxH = Math.max(40, holder.clientHeight - 14);
  const k = Math.min(maxW / layout.width, maxH / layout.height, Math.max(zoom * 3, 1));
  try {
    const url = await rgbaToPreviewUrl(composeRGBA(layout, cache.glyphs), layout.width, layout.height, k, 6);
    if (serial !== previewSerial) return;
    img.src = url;
    img.style.width = Math.max(1, Math.round(layout.width * k)) + "px";
    img.style.height = Math.max(1, Math.round(layout.height * k)) + "px";
    img.style.display = "block";
    placeholder.style.display = "none";
    msg.textContent = k < zoom - 0.001 ? "预览已缩小以适配面板，生成尺寸不受影响" : (k > zoom + 0.001 ? "预览已放大显示，生成尺寸不受影响" : "");
  } catch (e) {
    if (serial === previewSerial) { show("预览暂不可用，仍可尝试生成"); msg.textContent = errorText(e); }
  }
}

/* ---------- Placement, replace and output options ---------- */

function setSegment(selector, attr, value) {
  root.querySelectorAll(selector).forEach(el => {
    const on = el.getAttribute(attr) === value;
    el.classList.toggle("sf-selected", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function setPlace(mode) {
  placeMode = PLACES.includes(mode) ? mode : "canvas";
  writePref(PREF.place, placeMode);
  setSegment(".sf-place-option", "data-place", placeMode);
  $("sfReplaceRow").style.display = placeMode === "layer" ? "flex" : "none";
  refreshTargetInfo();
}

function setOutput(mode) {
  outputMode = OUTPUTS.includes(mode) ? mode : "layers";
  writePref(PREF.output, outputMode);
  setSegment(".sf-output-option", "data-output", outputMode);
  $("sfOutputNote").textContent = OUTPUT_NOTE[outputMode];
}

function setReplace(on) {
  replaceTarget = !!on;
  writePref(PREF.replace, replaceTarget);
  $("sfReplaceRow").setAttribute("aria-checked", replaceTarget ? "true" : "false");
  updateGenerateLabel();
}

function selectedLayerInfo() {
  try {
    if (!app.documents.length) return { error: "请先打开 Photoshop 文档" };
    const layers = Array.from(app.activeDocument.activeLayers || []);
    if (layers.length !== 1) return { error: layers.length ? "请只选中一个图层" : "请先选中一个图层" };
    return { layer: layers[0], name: layers[0].name, group: !!layers[0].layers };
  } catch (_) {
    return { error: "无法读取选中的图层" };
  }
}

function refreshTargetInfo() {
  const note = $("sfPlaceNote");
  if (placeMode !== "layer") { note.textContent = PLACE_NOTE[placeMode]; note.className = "sf-note"; updateGenerateLabel(); return; }
  const info = selectedLayerInfo();
  if (info.error) { note.textContent = "对齐到选中的图层 · " + info.error; note.className = "sf-note sf-status warning"; }
  else { note.textContent = "对齐到「" + info.name + "」" + (info.group ? "（组）" : "") + "，上下居中。"; note.className = "sf-note"; }
  updateGenerateLabel();
}

function updateGenerateLabel() {
  const text = $("textInput").value;
  const short = text.length > 12 ? text.slice(0, 12) + "…" : text;
  $("btnGenerate").textContent = placeMode === "layer" && replaceTarget ? "替换为 " + (short || "…") : "生成";
}

function unitValue(v) {
  return typeof v === "number" ? v : Number(v && (v._value !== undefined ? v._value : v.value));
}

function boundsOf(layer) {
  const b = layer.boundsNoEffects || layer.bounds;
  return { l: unitValue(b.left), t: unitValue(b.top), r: unitValue(b.right), b: unitValue(b.bottom) };
}

async function referenceRect(doc) {
  if (placeMode === "canvas") return { l: 0, t: 0, r: unitValue(doc.width), b: unitValue(doc.height) };
  if (placeMode === "selection") {
    let b = null;
    try { b = doc.selection && doc.selection.bounds; } catch (_) {}
    if (!b) {
      try {
        const r = await action.batchPlay([{ _obj: "get", _target: [{ _property: "selection" }, { _ref: "document", _id: doc.id }] }], {});
        const s = r && r[0] && r[0].selection;
        if (s && s.left !== undefined) b = s;
      } catch (_) {}
    }
    if (!b) throw new Error("当前没有选区。请先用选框工具画一个选区，或改用其他放置位置。");
    const rect = { l: unitValue(b.left), t: unitValue(b.top), r: unitValue(b.right), b: unitValue(b.bottom) };
    if (![rect.l, rect.t, rect.r, rect.b].every(Number.isFinite) || rect.r <= rect.l || rect.b <= rect.t) throw new Error("选区无效，请重新画一个选区。");
    return rect;
  }
  const info = selectedLayerInfo();
  if (info.error) throw new Error(info.error + "，或改用其他放置位置。");
  const rect = boundsOf(info.layer);
  if (![rect.l, rect.t, rect.r, rect.b].every(Number.isFinite) || rect.r <= rect.l || rect.b <= rect.t) throw new Error("选中的图层是空的，没有可以对齐的范围。");
  rect.layer = info.layer;
  return rect;
}

function findLayerById(layers, id) {
  for (const layer of Array.from(layers || [])) {
    if (layer.id === id) return layer;
    if (layer.layers) { const inside = findLayerById(layer.layers, id); if (inside) return inside; }
  }
  return null;
}

async function selectLayerById(id) {
  await action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: id }], makeVisible: false, _options: { dialogOptions: "dontDisplay" } }], {});
}

async function placeRGBA(doc, rgba, width, height, colorProfile, name, left, top) {
  const layer = await doc.createPixelLayer({ name });
  const options = { width, height, components: 4, chunky: true, colorSpace: "RGB" };
  if (colorProfile) options.colorProfile = colorProfile;
  const imageData = await imaging.createImageDataFromBuffer(rgba, options);
  try {
    await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData, replace: true, targetBounds: { left: Math.round(left), top: Math.round(top) }, commandName: "放置图片字" });
  } finally {
    imageData.dispose();
  }
  return layer;
}

/* ---------- Generate ---------- */

async function generateText() {
  if (generating) return;
  const lib = currentLibrary();
  if (!lib) { setStatus("请先导入一个字库。", "error"); return; }
  const text = $("textInput").value;
  if (!text) { setStatus("请输入要生成的内容。", "error"); return; }
  try { buildCharMap(lib); } catch (e) { setStatus(e.message, "error"); return; }
  if (!app.documents.length) { setStatus("请先打开一个 Photoshop 文档，再生成图片字。", "error"); return; }

  const doc = app.activeDocument;
  let ref;
  try { ref = await referenceRect(doc); } catch (e) { setStatus(e.message, "error"); return; }
  const replacing = placeMode === "layer" && replaceTarget;
  if (replacing) {
    if (ref.layer.isBackgroundLayer) { setStatus("背景图层不能被替换，请选择其他图层。", "error"); return; }
    if (ref.layer.allLocked || ref.layer.locked) { setStatus("选中的图层已锁定，请先解锁再替换。", "error"); return; }
  }

  generating = true;
  $("btnGenerate").classList.add("sf-busy");
  try {
    setStatus("正在读取字库…");
    const cache = await ensureGlyphs(lib);
    const layout = computeLayout(lib, text, cache.glyphs);
    if (layout.unsupported.length) throw new Error("当前字库不包含：" + layout.unsupported.join(" "));
    if (layout.empty) throw new Error("没有可以生成的字符。");

    const s = currentScale() / 100, align = currentAlign();
    const finalW = layout.width * s, finalH = layout.height * s;
    const X = Math.round(align === "left" ? ref.l : align === "right" ? ref.r - finalW : ref.l + (ref.r - ref.l - finalW) / 2);
    const Y = Math.round(ref.t + (ref.b - ref.t - finalH) / 2);
    // Unscaled origin: centred on the final box so scaling about the centre lands close to it.
    const O = s === 1 ? { x: X, y: Y } : { x: Math.round(X + finalW / 2 - layout.width / 2), y: Math.round(Y + finalH / 2 - layout.height / 2) };
    const targetId = replacing ? ref.layer.id : null, targetName = replacing ? ref.layer.name : "";
    const profile = cache.glyphs[layout.pieces[0].index].colorProfile;

    setStatus(replacing ? "正在替换…" : "正在生成…");
    await core.executeAsModal(async ctx => {
      // One history step: a single Ctrl+Z undoes the new layers and restores a replaced layer.
      const token = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "图片数字排版" });
      let committed = false;
      try {
        if (app.activeDocument.id !== doc.id) app.activeDocument = doc;
        let result;
        if (outputMode === "layers") {
          const created = [];
          for (let k = 0; k < layout.pieces.length; k++) {
            const p = layout.pieces[k], g = cache.glyphs[p.index];
            created.push(await placeRGBA(doc, g.rgba, g.width, g.height, g.colorProfile, (k + 1) + "_" + p.ch, O.x + p.x, O.y + p.y));
          }
          result = await doc.createLayerGroup({ name: text, fromLayers: created });
        } else {
          result = await placeRGBA(doc, composeRGBA(layout, cache.glyphs), layout.width, layout.height, profile, text, O.x, O.y);
          if (outputMode === "smart") {
            await selectLayerById(result.id);
            await action.batchPlay([{ _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }], {});
            const active = Array.from(doc.activeLayers || []);
            if (active.length !== 1) throw new Error("转换智能对象后无法取得结果图层。");
            result = active[0];
            result.name = text;
          }
        }
        if (s !== 1) {
          const before = boundsOf(result);
          await result.scale(s * 100, s * 100, constants.AnchorPosition.MIDDLECENTER, { interpolation: constants.InterpolationMethod.BICUBIC });
          // Correct the small drift from scaling about the pixel centre instead of the layout box.
          const after = boundsOf(result);
          const dx = Math.round(X + (before.l - O.x) * s - after.l), dy = Math.round(Y + (before.t - O.y) * s - after.t);
          if (dx || dy) await result.translate(dx, dy);
        }
        if (targetId !== null) {
          const target = findLayerById(doc.layers, targetId);
          if (target) await target.delete();
        }
        committed = true;
      } finally {
        await ctx.hostControl.resumeHistory(token, committed);
      }
    }, { commandName: "图片数字排版" });

    savePreviewSettings(lib);
    const what = OUTPUT_NOTE[outputMode] ? { layers: "独立图层组", merged: "合并图层", smart: "智能对象" }[outputMode] : "";
    setStatus((replacing ? "已把「" + targetName + "」替换为「" + text + "」" : "已生成「" + text + "」") + "（" + what + "）。可按 Ctrl+Z 撤销。", "success");
  } catch (e) {
    console.error(e);
    setStatus((replacing ? "替换失败：" : "生成失败：") + errorText(e), "error");
  } finally {
    generating = false;
    $("btnGenerate").classList.remove("sf-busy");
    refreshTargetInfo();
  }
}

/* ---------- Events ---------- */

function onActivate(el, handler) {
  el.addEventListener("click", handler);
  el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } });
}

function deleteLibraryClick() {
  const lib = currentLibrary();
  if (!lib) return;
  const btn = $("btnDelete");
  if (deleteArmed === null) {
    btn.textContent = "确认删除？";
    btn.classList.add("sf-btn-confirm");
    setStatus("再点一次「确认删除？」即可删除字库「" + (lib.name || lib.fileName) + "」。只从插件里移除，不会删除原图片。", "warning");
    deleteArmed = setTimeout(() => { deleteArmed = null; btn.textContent = "删除"; btn.classList.remove("sf-btn-confirm"); }, 3000);
    return;
  }
  clearTimeout(deleteArmed);
  deleteArmed = null;
  btn.textContent = "删除";
  btn.classList.remove("sf-btn-confirm");
  deleteLibrary();
}

function nudge(id, e) {
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  e.preventDefault();
  const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
  const current = Number($(id).value);
  let next = (Number.isFinite(current) ? Math.round(current) : 0) + step;
  if (id === "scaleInput") next = Math.max(10, Math.min(500, next));
  $(id).value = String(next);
  savePreviewSettings(currentLibrary());
  schedulePreview();
}

function wireEvents() {
  onActivate($("btnImport"), importLibrary);
  onActivate($("btnDelete"), deleteLibraryClick);
  onActivate($("btnGenerate"), generateText);
  onActivate($("btnManage"), () => setManagerOpen($("sfManager").style.display === "none"));
  onActivate($("btnSaveLibrary"), () => {
    const lib = currentLibrary();
    setManagerOpen(false);
    if (!lib) return;
    const count = getMappingChars(lib).length;
    if (count !== lib.boxes.length) setStatus(`映射有 ${count} 个字符，图片识别出 ${lib.boxes.length} 个，请保持数量一致。`, "warning");
    else setStatus("字库设置已保存。", "success");
  });

  $("textInput").addEventListener("input", schedulePreview);
  ["spacingInput", "scaleInput"].forEach(id => {
    $(id).addEventListener("input", () => { savePreviewSettings(currentLibrary()); schedulePreview(); });
    $(id).addEventListener("keydown", e => nudge(id, e));
  });

  root.querySelectorAll(".sf-align-option").forEach(item => {
    item.addEventListener("click", e => {
      e.preventDefault();
      const radio = item.querySelector('input[name="sfAlign"]');
      if (radio) radio.checked = true;
      updateAlignButtons();
      savePreviewSettings(currentLibrary());
    });
  });
  root.querySelectorAll(".sf-place-option").forEach(el => onActivate(el, () => setPlace(el.getAttribute("data-place"))));
  root.querySelectorAll(".sf-output-option").forEach(el => onActivate(el, () => setOutput(el.getAttribute("data-output"))));
  onActivate($("sfReplaceRow"), () => setReplace(!replaceTarget));
  onActivate($("sfMono"), () => {
    const lib = currentLibrary();
    if (!lib) { setStatus("请先导入字库。", "error"); return; }
    lib.mono = !lib.mono;
    saveLibraries();
    $("sfMono").setAttribute("aria-pressed", lib.mono ? "true" : "false");
    schedulePreview();
  });

  $("librarySelect").addEventListener("change", (event) => {
    selectedLibraryId = event.target.value;
    localStorage.setItem(SELECTED_KEY, selectedLibraryId || "");
    renderLibraryEditor();
    readPreviewPreferences(currentLibrary());
    schedulePreview();
  });

  // Mapping and name are saved as you type, so preview, generation and the next session agree.
  $("mappingInput").addEventListener("input", () => {
    const lib = currentLibrary();
    if (!lib) return;
    lib.mapping = $("mappingInput").value;
    saveLibraries();
    refreshMappedGlyphLabels();
    renderLibraryMeta();
    schedulePreview();
  });
  $("libraryName").addEventListener("change", () => {
    const lib = currentLibrary();
    if (!lib) return;
    lib.name = $("libraryName").value.trim() || stripExtension(lib.fileName);
    saveLibraries();
    const option = Array.from($("librarySelect").options).find(o => o.value === lib.id);
    if (option) option.textContent = lib.name;
  });

  try {
    action.addNotificationListener(["select", "open", "close"], () => {
      if (root.style.display !== "none" && placeMode === "layer") refreshTargetInfo();
    });
  } catch (e) {
    console.warn("[Sprite Font] selection listener unavailable", e);
  }
}

wireEvents();
renderLibraries();
setManagerOpen(false);
setOutput(outputMode);
setReplace(replaceTarget);
setPlace(placeMode);
};

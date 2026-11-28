/* Bounds Frame (边界框) - Photoshop UXP. Independent of Smart Arrange.
   Kept: editable vector rectangles, Photoshop colour picker, follow-object / fixed size,
   even integer sizes, integer coordinates, one history step.
   v3: exact visible-pixel measurement (each object read at full resolution around its own
   bounds instead of a 1400px downscaled canvas), remembered settings, live selection
   info and size list, colour chips with recent colours, solid / dashed stroke,
   corner radius, "use largest object" for fixed size.
   Export: for each selected object, find "<name> - 边界框" in the same parent and save
   a transparent PNG of only that object, cropped to the frame, named after the layer. */
module.exports = function initBoundsFrame(root) {
  "use strict";
  const ps = require("photoshop"), app = ps.app, core = ps.core, imaging = ps.imaging;
  const $ = id => root.querySelector("#" + id);
  const SETTINGS_KEY = "boundsFrame.v3.settings";
  const FOLDER_KEY = "boundsFrame.v3.exportFolder";
  const FRAME_SUFFIX = " - 边界框", GROUP_SUFFIX = " - 边界框组";
  const fs = require("uxp").storage.localFileSystem;
  let exportFolder = null;
  const PRESET_COLORS = ["#20CF52", "#FF3B30", "#1473E6", "#FFCC00", "#AF52DE", "#FFFFFF"];
  const MAX_MEASURE_SIDE = 4096; // above this the read is downscaled (warned in the list)
  let busy = false, snapshot = null, liveTimer = null;
  const uiState = { sizeMode: "auto", group: false, precise: true, line: "dashed", recent: [] };
  let currentColor = "#20CF52";

  const scalar = v => typeof v === "number" ? v : Number(v && (v.value !== undefined ? v.value : v._value));
  function rect(layer, withEffects) {
    const b = withEffects ? (layer.bounds || layer.boundsNoEffects) : (layer.boundsNoEffects || layer.bounds);
    const v = { l: scalar(b.left), t: scalar(b.top), r: scalar(b.right), b: scalar(b.bottom) };
    v.w = v.r - v.l; v.h = v.b - v.t;
    if (![v.l, v.t, v.r, v.b, v.w, v.h].every(Number.isFinite) || v.w <= 0 || v.h <= 0) throw Error("无有效边界：" + layer.name);
    return v;
  }
  function pathOf(doc, layer) {
    const path = []; let node = layer;
    while (node && node.id !== doc.id) {
      const parent = node.parent;
      const siblings = Array.from(parent && parent.id !== doc.id ? parent.layers : doc.layers);
      const i = siblings.findIndex(x => x.id === node.id);
      if (i < 0) throw Error("无法定位图层：" + layer.name);
      path.unshift(i);
      if (!parent || parent.id === doc.id) break;
      node = parent;
    }
    return path;
  }
  function descendants(layers) {
    const result = [];
    for (const layer of Array.from(layers || [])) {
      result.push(layer);
      if (layer.layers) result.push(...descendants(layer.layers));
    }
    return result;
  }
  function pickedTargets(doc) {
    const picked = Array.from(doc.activeLayers || []);
    if (!picked.length) throw Error("请先在图层面板选中图层或组。");
    const ids = new Set(picked.map(x => x.id));
    const filtered = picked.filter(layer => {
      let parent = layer.parent;
      while (parent && parent.id !== doc.id) {
        if (ids.has(parent.id)) return false;
        parent = parent.parent;
      }
      return true;
    });
    return filtered.map(layer => {
      const raw = rect(layer, false);
      let outer = raw;
      try { outer = rect(layer, true); } catch (_) {}
      return { layer, id: layer.id, name: layer.name, path: pathOf(doc, layer), raw, outer, box: null };
    });
  }

  // Isolate the target in the scratch copy, then read only the area around it at full
  // resolution, so the measured edges are pixel-exact (unless the area exceeds 4096 px).
  // Show only the layer at `path` (and its ancestors) in the scratch copy.
  function isolate(copyDoc, path) {
    let siblings = Array.from(copyDoc.layers);
    for (const index of path) {
      const target = siblings[index];
      if (!target) throw Error("临时文档层级变化");
      for (const l of siblings) l.visible = l.id === target.id;
      siblings = Array.from(target.layers || []);
    }
  }
  async function alphaBox(copyDoc, item) {
    isolate(copyDoc, item.path);
    const docW = Number(copyDoc.width), docH = Number(copyDoc.height);
    const pad = 2;
    const region = {
      left: Math.max(0, Math.floor(Math.min(item.raw.l, item.outer.l)) - pad),
      top: Math.max(0, Math.floor(Math.min(item.raw.t, item.outer.t)) - pad),
      right: Math.min(docW, Math.ceil(Math.max(item.raw.r, item.outer.r)) + pad),
      bottom: Math.min(docH, Math.ceil(Math.max(item.raw.b, item.outer.b)) + pad)
    };
    if (region.right <= region.left || region.bottom <= region.top) throw Error("对象在画布之外");
    const rw = region.right - region.left, rh = region.bottom - region.top;
    const scale = Math.min(1, MAX_MEASURE_SIDE / Math.max(rw, rh));
    const o = { documentID: copyDoc.id, componentSize: 8, colorSpace: "RGB", applyAlpha: false, sourceBounds: region };
    if (scale < 1) o.targetSize = { width: Math.max(1, Math.round(rw * scale)), height: Math.max(1, Math.round(rh * scale)) };
    let image;
    try {
      const result = await imaging.getPixels(o);
      image = result.imageData;
      if (!image || image.components !== 4) throw Error("无法获取 RGBA 像素");
      const pixels = await image.getData({ chunky: true }), w = image.width, h = image.height, c = image.components;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (pixels[(y * w + x) * c + 3] > 12) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      if (maxX < 0) throw Error("没有可见像素");
      const b = result.sourceBounds || region, lev = Math.pow(2, Math.max(0, Number(result.level) || 0));
      const x = Number(b.left) * lev, y = Number(b.top) * lev;
      const dw = (Number(b.right) - Number(b.left)) * lev, dh = (Number(b.bottom) - Number(b.top)) * lev;
      return { l: x + minX * dw / w, t: y + minY * dh / h, r: x + (maxX + 1) * dw / w, b: y + (maxY + 1) * dh / h, approx: scale < 1 || lev > 1 };
    } finally { if (image) image.dispose(); }
  }

  function say(message, kind) {
    $("bfStatus").textContent = message;
    $("bfStatus").className = "bf-status" + (kind === "error" ? " bf-error" : kind === "ok" ? " bf-ok" : "");
  }

  /* ---------- Settings ---------- */

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
      if (!s) return;
      if (/^#[0-9A-F]{6}$/i.test(s.color || "")) currentColor = s.color.toUpperCase();
      [["bfOpacity", "opacity"], ["bfStroke", "stroke"], ["bfDash", "dash"], ["bfMargin", "margin"], ["bfRadius", "radius"], ["bfWidth", "width"], ["bfHeight", "height"]]
        .forEach(([id, key]) => { if (s[key] !== undefined && s[key] !== null) $(id).value = String(s[key]); });
      if (s.sizeMode === "fixed" || s.sizeMode === "auto") uiState.sizeMode = s.sizeMode;
      if (typeof s.group === "boolean") uiState.group = s.group;
      if (typeof s.precise === "boolean") uiState.precise = s.precise;
      if (s.line === "solid" || s.line === "dashed") uiState.line = s.line;
      if (Array.isArray(s.recent)) uiState.recent = s.recent.filter(c => /^#[0-9A-F]{6}$/i.test(c)).slice(0, 4);
    } catch (_) {}
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        color: currentColor, opacity: $("bfOpacity").value, stroke: $("bfStroke").value, dash: $("bfDash").value,
        margin: $("bfMargin").value, radius: $("bfRadius").value, width: $("bfWidth").value, height: $("bfHeight").value,
        sizeMode: uiState.sizeMode, group: uiState.group, precise: uiState.precise, line: uiState.line, recent: uiState.recent
      }));
    } catch (_) {}
  }

  /* ---------- Colour ---------- */

  function setColor(value) {
    const hex = String(value || "").trim().toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) throw Error("请输入 #RRGGBB 格式的颜色。");
    currentColor = hex;
    $("bfSwatch").style.backgroundColor = hex;
    $("bfHex").value = hex;
    renderChips();
    saveSettings();
  }
  function rememberColor(hex) {
    if (PRESET_COLORS.includes(hex)) return;
    uiState.recent = [hex].concat(uiState.recent.filter(c => c !== hex)).slice(0, 4);
    saveSettings();
    renderChips();
  }
  function renderChips() {
    const box = $("bfChips");
    box.innerHTML = "";
    PRESET_COLORS.concat(uiState.recent).forEach(hex => {
      const chip = document.createElement("div");
      chip.className = "bf-chip" + (hex === currentColor ? " bf-chip-on" : "");
      chip.style.backgroundColor = hex;
      chip.title = hex;
      chip.setAttribute("role", "button");
      chip.addEventListener("click", () => setColor(hex));
      box.appendChild(chip);
    });
  }
  async function openPicker() {
    if (busy) return;
    busy = true;
    try {
      // UXP does not implement input[type=color]; use the Photoshop picker.
      const result = await core.executeAsModal(async () => {
        const output = await ps.action.batchPlay([
          { _obj: "showColorPicker", _target: [{ _ref: "application" }], context: "边界框颜色", color: rgbDescriptor(hexRgb(currentColor)) }
        ], { synchronousExecution: false });
        return output && output[0];
      }, { commandName: "选择边界框颜色" });
      const rgb = result && (result.RGBFloatColor || result.RGBColor);
      if (rgb) {
        const components = [rgb.red, rgb.grain !== undefined ? rgb.grain : rgb.green, rgb.blue];
        if (components.every(v => Number.isFinite(Number(v)))) {
          const normalized = components.map(Number);
          const multiplier = Math.max(...normalized) <= 1 ? 255 : 1;
          const hex = "#" + normalized.map(v => Math.max(0, Math.min(255, Math.round(v * multiplier))).toString(16).padStart(2, "0")).join("");
          setColor(hex);
          rememberColor(currentColor);
        }
      } else if (result && /error/i.test(result._obj || "")) {
        throw Error(result.message || "无法打开 Photoshop 选色器");
      }
    } catch (error) { say("颜色选择失败：" + (error.message || error), "error"); }
    finally { busy = false; }
  }
  function hexRgb(hex) {
    const text = String(hex || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(text)) throw Error("请输入 #RRGGBB 格式的颜色。");
    return [1, 3, 5].map(i => parseInt(text.substring(i, i + 2), 16));
  }

  /* ---------- Options and measurement ---------- */

  function number(id, min, max, label) {
    const v = Number($(id).value);
    if (!Number.isFinite(v)) throw Error((label || "参数") + "不是有效数字。");
    return Math.max(min, Math.min(max, Math.round(v)));
  }
  // Round dimensions normally, then advance odd values to the next even pixel.
  function evenDimension(value) {
    const rounded = Math.max(2, Math.round(value));
    return rounded % 2 === 0 ? rounded : rounded + 1;
  }
  function positiveDimension(id) {
    const value = Number($(id).value);
    if (!Number.isFinite(value) || value < 2 || value > 100000) throw Error("统一尺寸需要 2–100000 之间的有效像素数值。");
    return evenDimension(value);
  }
  function options() {
    return {
      rgb: hexRgb(currentColor), opacity: number("bfOpacity", 0, 100, "填充不透明度"),
      stroke: number("bfStroke", 1, 50, "描边粗细"), dash: number("bfDash", 1, 200, "虚线长度"),
      radius: number("bfRadius", 0, 10000, "圆角"), solid: uiState.line === "solid",
      margin: number("bfMargin", 0, 1000, "边缘留白"), group: uiState.group, precise: uiState.precise,
      sizeMode: uiState.sizeMode,
      fixedWidth: uiState.sizeMode === "fixed" ? positiveDimension("bfWidth") : 0,
      fixedHeight: uiState.sizeMode === "fixed" ? positiveDimension("bfHeight") : 0
    };
  }

  function renderList(items, measuredPrecisely) {
    const list = $("bfList");
    list.innerHTML = "";
    if (!items || !items.length) { list.style.display = "none"; return; }
    list.style.display = "block";
    const head = document.createElement("div");
    head.className = "bf-list-head";
    const a = document.createElement("span"); a.textContent = "对象";
    const b = document.createElement("span"); b.textContent = measuredPrecisely ? "可见像素尺寸" : "图层边界尺寸（快速）";
    head.appendChild(a); head.appendChild(b); list.appendChild(head);
    items.slice(0, 30).forEach(item => {
      const box = item.box || item.raw;
      const row = document.createElement("div"); row.className = "bf-list-row";
      const name = document.createElement("span"); name.className = "bf-list-name"; name.textContent = item.name;
      const size = document.createElement("span");
      size.className = "bf-list-size" + (!measuredPrecisely || item.fallback || box.approx ? " bf-approx" : "");
      size.textContent = Math.round(box.r - box.l) + " × " + Math.round(box.b - box.t) + (item.fallback ? "（边界）" : box.approx ? "（约）" : "");
      row.appendChild(name); row.appendChild(size); list.appendChild(row);
    });
    if (items.length > 30) {
      const more = document.createElement("div"); more.className = "bf-list-more"; more.textContent = "另外 " + (items.length - 30) + " 个对象";
      list.appendChild(more);
    }
  }
  function showSelection(items) {
    $("bfCount").textContent = items.length + " 个对象";
    $("bfNames").textContent = items.slice(0, 4).map(i => i.name).join("、") + (items.length > 4 ? "…" : "");
  }

  async function read(precise) {
    const doc = app.activeDocument;
    if (!doc) throw Error("请先打开 Photoshop 文档。");
    const items = pickedTargets(doc);
    if (items.length > 80) throw Error("单次最多处理 80 个对象。");
    if (precise) {
      await core.executeAsModal(async () => {
        let copy;
        try {
          copy = await doc.duplicate("边界框_临时测量", false);
          const all = descendants(copy.layers);
          const original = new Map(all.map(l => [l.id, l.visible]));
          for (const item of items) {
            for (const layer of all) layer.visible = original.get(layer.id);
            try { item.box = await alphaBox(copy, item); }
            catch (error) { item.box = item.raw; item.fallback = String(error.message || error); }
          }
        } finally {
          if (copy) await copy.close(ps.constants.SaveOptions.DONOTSAVECHANGES);
        }
      }, { commandName: "边界框：临时读取" });
    } else items.forEach(i => { i.box = i.raw; });
    snapshot = { docId: doc.id, items, precise };
    showSelection(items);
    renderList(items, precise);
    const fallback = items.filter(i => i.fallback);
    say("已测量 " + items.length + " 个对象" + (fallback.length ? "；" + fallback.length + " 个对象无法读取可见像素，已改用图层边界" : "") + "。", fallback.length ? "error" : "");
    return snapshot;
  }

  // Lightweight update on selection change: names and fast layer bounds only.
  function liveSelection() {
    if (busy || root.style.display === "none") return;
    try {
      const doc = app.activeDocument;
      if (!doc) throw Error("请先打开 Photoshop 文档。");
      const items = pickedTargets(doc);
      items.forEach(i => { i.box = i.raw; });
      const same = snapshot && snapshot.docId === doc.id && snapshot.items.length === items.length &&
        items.every(x => snapshot.items.some(y => y.id === x.id && JSON.stringify(y.raw) === JSON.stringify(x.raw)));
      if (same) return; // keep the precise measurement already shown
      snapshot = null;
      showSelection(items);
      renderList(items, false);
      say(uiState.precise ? "生成时会精确测量可见像素；也可点「重新测量」先查看。" : "已读取 " + items.length + " 个对象。");
    } catch (error) {
      snapshot = null;
      $("bfCount").textContent = "尚未选择对象";
      $("bfNames").textContent = String(error.message || error);
      renderList([], false);
    }
  }
  function scheduleLive() {
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveTimer = null; liveSelection(); }, 200);
  }

  function targetFrameBounds(box, opt) {
    const centerX = (box.l + box.r) / 2, centerY = (box.t + box.b) / 2;
    const margin = opt.sizeMode === "fixed" ? 0 : opt.margin;
    const width = opt.sizeMode === "fixed" ? opt.fixedWidth : evenDimension(box.r - box.l + margin * 2);
    const height = opt.sizeMode === "fixed" ? opt.fixedHeight : evenDimension(box.b - box.t + margin * 2);
    const left = Math.round(centerX - width / 2), top = Math.round(centerY - height / 2);
    return { l: left, t: top, r: left + width, b: top + height };
  }
  function rgbDescriptor(rgb) { return { _obj: "RGBColor", red: rgb[0], grain: rgb[1], blue: rgb[2] }; }
  function pixel(v) { return { _unit: "pixelsUnit", _value: v }; }
  function point(v) { return { _unit: "pointsUnit", _value: v }; }

  async function makeVectorFrame(doc, box, opt, name) {
    // targetFrameBounds has already applied margins, integer coordinates and even sizes.
    const left = box.l, top = box.t, right = box.r, bottom = box.b;
    if (![left, top, right, bottom].every(Number.isFinite) || right - left < 2 || bottom - top < 2)
      throw Error("无法生成尺寸无效的矢量矩形。");
    const radius = Math.min(opt.radius, Math.floor(Math.min(right - left, bottom - top) / 2));
    const descriptor = {
      _obj: "make", _target: [{ _ref: "contentLayer" }],
      using: {
        _obj: "contentLayer",
        name: name,
        type: { _obj: "solidColorLayer", color: rgbDescriptor(opt.rgb) },
        shape: { _obj: "rectangle", unitValueQuadVersion: 1, top: pixel(top), left: pixel(left), bottom: pixel(bottom), right: pixel(right), topLeft: pixel(radius), topRight: pixel(radius), bottomLeft: pixel(radius), bottomRight: pixel(radius) },
        strokeStyle: {
          _obj: "strokeStyle", strokeStyleVersion: 2,
          strokeEnabled: true, fillEnabled: true,
          strokeStyleLineWidth: pixel(opt.stroke),
          strokeStyleLineDashOffset: point(0),
          strokeStyleMiterLimit: 100,
          strokeStyleLineCapType: { _enum: "strokeStyleLineCapType", _value: "strokeStyleButtCap" },
          strokeStyleLineJoinType: { _enum: "strokeStyleLineJoinType", _value: "strokeStyleMiterJoin" },
          strokeStyleLineAlignment: { _enum: "strokeStyleLineAlignment", _value: "strokeStyleAlignInside" },
          strokeStyleScaleLock: false, strokeStyleStrokeAdjust: false,
          strokeStyleLineDashSet: opt.solid ? [] : [point(opt.dash), point(opt.dash)],
          strokeStyleBlendMode: { _enum: "blendMode", _value: "normal" },
          strokeStyleOpacity: { _unit: "percentUnit", _value: 100 },
          strokeStyleContent: { _obj: "solidColorLayer", color: rgbDescriptor(opt.rgb) },
          strokeStyleResolution: 72
        }
      },
      _options: { dialogOptions: "dontDisplay" }
    };
    const response = await ps.action.batchPlay([descriptor], { synchronousExecution: false });
    if (!response || !response[0] || /error/i.test(response[0]._obj || ""))
      throw Error("Photoshop 创建矢量形状失败：" + (response && response[0] && response[0].message || "未知错误"));
    const frame = Array.from(doc.activeLayers || [])[0];
    if (!frame || frame.id === undefined || (ps.constants.LayerKind.SOLIDFILL && frame.kind !== ps.constants.LayerKind.SOLIDFILL))
      throw Error("未能确认新建的形状图层，请检查 Photoshop 日志。");
    frame.name = name;
    frame.fillOpacity = opt.opacity;
    return frame;
  }
  async function restoreSelection(doc, ids) {
    if (!ids.length) return;
    await ps.action.batchPlay([{ _obj: "select", _target: [{ _ref: "layer", _id: ids[0] }],
      makeVisible: false, layerID: ids, selectionModifier: { _enum: "selectionModifierType", _value: "addToSelection" }, _options: { dialogOptions: "dontDisplay" } }], { synchronousExecution: false });
  }

  function setBusy(on) {
    busy = on;
    ["bfGenerate", "bfRead", "bfUseMax", "bfExport", "bfFolder"].forEach(id => $(id).classList.toggle("bf-busy", on));
  }

  /* ---------- Export by frame ---------- */

  function showFolder() {
    const el = $("bfFolderPath");
    if (exportFolder) { el.textContent = fs.getNativePath(exportFolder) || exportFolder.name; el.className = "bf-folder-path"; }
    else { el.textContent = "尚未选择文件夹"; el.className = "bf-folder-path bf-empty"; }
  }
  async function restoreFolder() {
    const token = localStorage.getItem(FOLDER_KEY);
    if (!token) { showFolder(); return; }
    try {
      const entry = await fs.getEntryForPersistentToken(token);
      exportFolder = entry && entry.isFolder ? entry : null;
    } catch (_) { exportFolder = null; localStorage.removeItem(FOLDER_KEY); }
    showFolder();
  }
  async function chooseFolder() {
    const folder = await fs.getFolder();
    if (!folder) return false;
    exportFolder = folder;
    try { localStorage.setItem(FOLDER_KEY, await fs.createPersistentToken(folder)); } catch (_) {}
    showFolder();
    return true;
  }
  const safeFileName = name => String(name || "未命名").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+$/g, "").trim() || "未命名";

  // Pair each selected object with "<name> - 边界框" in the same parent.
  // Selecting a "<name> - 边界框组" group uses the object and frame inside it.
  function exportPairs(doc) {
    const picked = Array.from(doc.activeLayers || []);
    if (!picked.length) throw Error("请先选中要切的对象（可多选）。");
    const pairs = [], skipped = [], seen = new Set();
    for (let layer of picked) {
      if (layer.name.endsWith(FRAME_SUFFIX)) continue; // a frame itself is not an object
      if (layer.layers && layer.name.endsWith(GROUP_SUFFIX)) {
        const base = layer.name.slice(0, -GROUP_SUFFIX.length);
        const inner = Array.from(layer.layers).find(l => l.name === base);
        if (inner) layer = inner;
      }
      if (seen.has(layer.id)) continue;
      seen.add(layer.id);
      const parent = layer.parent;
      const siblings = Array.from(parent && parent.id !== doc.id ? parent.layers : doc.layers);
      const at = siblings.findIndex(l => l.id === layer.id);
      const wanted = layer.name + FRAME_SUFFIX;
      // Prefer the frame right below the object, then any match in the same parent.
      const frame = (siblings[at + 1] && siblings[at + 1].name === wanted) ? siblings[at + 1] : siblings.find(l => l.name === wanted);
      if (!frame) { skipped.push(layer.name); continue; }
      const f = rect(frame, false);
      const box = { l: Math.round(f.l), t: Math.round(f.t), r: Math.round(f.r), b: Math.round(f.b) };
      let outer = null;
      try { outer = rect(layer, true); } catch (_) {}
      pairs.push({ layer, name: layer.name, path: pathOf(doc, layer), box, outer });
    }
    return { pairs, skipped };
  }

  async function exportByFrames() {
    if (busy) return;
    setBusy(true);
    try {
      const doc = app.activeDocument;
      if (!doc) throw Error("请先打开 Photoshop 文档。");
      const { pairs, skipped } = exportPairs(doc);
      if (!pairs.length) throw Error(skipped.length ? "选中的对象都没有找到对应的「对象名 - 边界框」：" + skipped.join("、") : "没有可切图的对象。");
      if (!exportFolder && !(await chooseFolder())) { say("已取消：没有选择保存文件夹。"); return; }
      const existing = new Set((await exportFolder.getEntries()).map(e => e.name.toLowerCase()));
      const uniqueName = base => {
        let name = base + ".png", n = 2;
        while (existing.has(name.toLowerCase())) name = base + "_" + (n++) + ".png";
        existing.add(name.toLowerCase());
        return name;
      };
      const clipped = [], saved = [];
      say("正在切图 " + pairs.length + " 个对象…");
      await core.executeAsModal(async ctx => {
        let copy;
        try {
          copy = await doc.duplicate("边界框_临时切图", false);
          const docW = Number(copy.width), docH = Number(copy.height), resolution = Number(doc.resolution) || 72;
          const all = descendants(copy.layers);
          const original = new Map(all.map(l => [l.id, l.visible]));
          for (let k = 0; k < pairs.length; k++) {
            const item = pairs[k], box = item.box, w = box.r - box.l, h = box.b - box.t;
            ctx.reportProgress({ value: k / pairs.length, commandName: "切图 " + item.name });
            if (w < 1 || h < 1) { skipped.push(item.name + "（边界框尺寸无效）"); continue; }
            for (const layer of all) layer.visible = original.get(layer.id);
            isolate(copy, item.path); // also turns the object itself on, even if it was hidden
            if (item.outer && (item.outer.l < box.l || item.outer.t < box.t || item.outer.r > box.r || item.outer.b > box.b)) clipped.push(item.name);
            // Read the visible composite inside the frame; areas outside the canvas stay transparent.
            const rgba = new Uint8Array(w * h * 4);
            const src = { left: Math.max(0, box.l), top: Math.max(0, box.t), right: Math.min(docW, box.r), bottom: Math.min(docH, box.b) };
            let profile = "";
            if (src.right > src.left && src.bottom > src.top) {
              const result = await imaging.getPixels({ documentID: copy.id, sourceBounds: src, colorSpace: "RGB", componentSize: 8, applyAlpha: false });
              const image = result.imageData;
              try {
                profile = image.colorProfile || "";
                const data = await image.getData({ chunky: true }), iw = image.width, ih = image.height, c = image.components;
                const sb = result.sourceBounds || src, ox = Number(sb.left) - box.l, oy = Number(sb.top) - box.t;
                for (let y = 0; y < ih; y++) {
                  const ty = oy + y; if (ty < 0 || ty >= h) continue;
                  for (let x = 0; x < iw; x++) {
                    const tx = ox + x; if (tx < 0 || tx >= w) continue;
                    const si = (y * iw + x) * c, di = (ty * w + tx) * 4;
                    rgba[di] = data[si]; rgba[di + 1] = data[si + 1]; rgba[di + 2] = data[si + 2];
                    rgba[di + 3] = c === 4 ? data[si + 3] : 255;
                  }
                }
              } finally { image.dispose(); }
            }
            const fileName = uniqueName(safeFileName(item.name));
            const out = await app.documents.add({ name: fileName.replace(/\.png$/i, ""), width: w, height: h, resolution, mode: "RGBColorMode", fill: "transparent" });
            try {
              const target = Array.from(out.layers)[0];
              const options = { width: w, height: h, components: 4, chunky: true, colorSpace: "RGB" };
              if (profile) options.colorProfile = profile;
              const imageData = await imaging.createImageDataFromBuffer(rgba, options);
              try {
                await imaging.putPixels({ documentID: out.id, layerID: target.id, imageData, targetBounds: { left: 0, top: 0 }, replace: true, commandName: "写入切图像素" });
              } finally { imageData.dispose(); }
              const file = await exportFolder.createFile(fileName, { overwrite: false });
              await out.saveAs.png(file, { compression: 6, interlaced: false, method: ps.constants.PNGMethod.QUICK }, true);
              saved.push(fileName);
            } finally {
              await out.close(ps.constants.SaveOptions.DONOTSAVECHANGES);
            }
          }
        } finally {
          if (copy) await copy.close(ps.constants.SaveOptions.DONOTSAVECHANGES);
          try { app.activeDocument = doc; } catch (_) {}
        }
      }, { commandName: "按边界框切图" });
      let text = "已切出 " + saved.length + " 张 PNG，保存在：" + (fs.getNativePath(exportFolder) || exportFolder.name) + "。";
      if (skipped.length) text += "\n跳过（没找到对应边界框）：" + skipped.join("、");
      if (clipped.length) text += "\n注意：这些对象比边界框大，超出部分已被裁掉：" + clipped.join("、");
      say(text, skipped.length || clipped.length ? "error" : "ok");
    } catch (error) {
      say("切图失败：" + String(error.message || error) + "。原文件没有被修改。", "error");
      console.error("[Bounds Frame export]", error);
    } finally { setBusy(false); }
  }

  async function freshSnapshot(precise) {
    const doc = app.activeDocument;
    if (!doc) throw Error("请先打开 Photoshop 文档。");
    const fresh = pickedTargets(doc);
    const cached = snapshot && snapshot.docId === doc.id && snapshot.precise === precise &&
      snapshot.items.length === fresh.length && fresh.every(x => snapshot.items.some(y => y.id === x.id &&
        JSON.stringify(y.raw) === JSON.stringify(x.raw)));
    if (!cached) await read(precise);
    return { doc, fresh };
  }

  async function create() {
    if (busy) return;
    setBusy(true);
    try {
      const opt = options();
      // Snapshot selections BEFORE creating layers; Photoshop changes the active selection.
      const { doc, fresh } = await freshSnapshot(opt.precise);
      const selectedIds = fresh.map(i => i.id);
      const items = snapshot.items.slice().sort((a, b) => {
        for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
        return a.path.length - b.path.length;
      });
      say("正在生成 " + items.length + " 个独立矩形框…");
      await core.executeAsModal(async ctx => {
        const token = await ctx.hostControl.suspendHistory({ documentID: doc.id, name: "批量生成边界框" });
        try {
          for (const item of items) {
            const source = item.layer;
            const frame = await makeVectorFrame(doc, targetFrameBounds(item.box, opt), opt, item.name + " - 边界框");
            // Move below the entire original group, not inside it.
            frame.move(source, ps.constants.ElementPlacement.PLACEAFTER);
            if (opt.group) {
              const wrapper = await doc.createLayerGroup({ name: item.name + " - 边界框组" });
              wrapper.move(source, ps.constants.ElementPlacement.PLACEBEFORE);
              source.move(wrapper, ps.constants.ElementPlacement.PLACEINSIDE);
              frame.move(wrapper, ps.constants.ElementPlacement.PLACEINSIDE);
              source.move(frame, ps.constants.ElementPlacement.PLACEBEFORE);
            }
          }
        } finally {
          try { await restoreSelection(doc, selectedIds); } catch (e) { console.warn("[Bounds Frame] restore selection:", e); }
          await ctx.hostControl.resumeHistory(token);
        }
      }, { commandName: "批量生成边界框" });
      snapshot = null;
      rememberColor(currentColor);
      saveSettings();
      say("已为 " + items.length + " 个对象分别生成矩形框，可按 Ctrl+Z 撤销。", "ok");
    } catch (error) {
      say("生成失败：" + String(error.message || error) + "；如有部分生成，可按 Ctrl+Z 撤销。", "error");
      console.error("[Bounds Frame]", error);
    } finally { setBusy(false); }
  }

  async function useLargest() {
    if (busy) return;
    setBusy(true);
    try {
      await freshSnapshot(uiState.precise);
      const boxes = snapshot.items.map(i => i.box || i.raw);
      const w = evenDimension(Math.max(...boxes.map(b => b.r - b.l)));
      const h = evenDimension(Math.max(...boxes.map(b => b.b - b.t)));
      $("bfWidth").value = String(w);
      $("bfHeight").value = String(h);
      saveSettings();
      say("已按最大对象设为 " + w + " × " + h + " px" + (uiState.precise ? "（可见像素）" : "（图层边界）") + "。", "ok");
    } catch (error) { say(String(error.message || error), "error"); }
    finally { setBusy(false); }
  }

  /* ---------- UI state ---------- */

  function syncChoices() {
    const fixed = uiState.sizeMode === "fixed";
    root.querySelectorAll(".bf-choice[data-mode]").forEach(el => {
      const on = el.getAttribute("data-mode") === uiState.sizeMode;
      el.classList.toggle("bf-selected", on);
      el.setAttribute("aria-checked", String(on));
    });
    root.querySelectorAll(".bf-line-option").forEach(el => {
      const on = el.getAttribute("data-line") === uiState.line;
      el.classList.toggle("bf-selected", on);
      el.setAttribute("aria-checked", String(on));
    });
    $("bfFixedDimensions").style.display = fixed ? "flex" : "none";
    $("bfAutoFields").style.display = fixed ? "none" : "flex";
    $("bfMarginNote").textContent = fixed
      ? "每个框都用这个尺寸，以对象可见范围的中心对齐，不缩放原对象。"
      : "每个框按对象的实际范围生成，尺寸取偶数。";
    $("bfDash").disabled = uiState.line === "solid";
    $("bfGroup").setAttribute("aria-checked", String(uiState.group));
    $("bfPrecise").setAttribute("aria-checked", String(uiState.precise));
  }

  function onActivate(el, handler) {
    el.addEventListener("click", handler);
    el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } });
  }
  function nudge(id, e) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const current = Number($(id).value);
    $(id).value = String(Math.max(0, (Number.isFinite(current) ? Math.round(current) : 0) + (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1)));
    saveSettings();
  }

  root.querySelectorAll(".bf-choice[data-mode]").forEach(el => onActivate(el, () => {
    uiState.sizeMode = el.getAttribute("data-mode"); syncChoices(); saveSettings();
  }));
  root.querySelectorAll(".bf-line-option").forEach(el => onActivate(el, () => {
    uiState.line = el.getAttribute("data-line"); syncChoices(); saveSettings();
  }));
  onActivate($("bfGroup"), () => { uiState.group = !uiState.group; syncChoices(); saveSettings(); });
  onActivate($("bfPrecise"), () => {
    uiState.precise = !uiState.precise; snapshot = null; syncChoices(); saveSettings();
    say(uiState.precise ? "已开启精确测量，生成前会读取可见像素。" : "已改用快速图层边界。");
  });
  onActivate($("bfPick"), openPicker);
  $("bfHex").addEventListener("change", () => {
    try { setColor($("bfHex").value); rememberColor(currentColor); }
    catch (error) { say(error.message, "error"); setColor(currentColor); }
  });
  ["bfOpacity", "bfStroke", "bfDash", "bfMargin", "bfRadius", "bfWidth", "bfHeight"].forEach(id => {
    $(id).addEventListener("change", saveSettings);
    $(id).addEventListener("keydown", e => nudge(id, e));
  });
  onActivate($("bfRead"), async () => {
    if (busy) return;
    setBusy(true);
    try { await read(uiState.precise); } catch (e) { say(e.message || String(e), "error"); }
    finally { setBusy(false); }
  });
  onActivate($("bfUseMax"), useLargest);
  onActivate($("bfGenerate"), create);
  onActivate($("bfExport"), exportByFrames);
  onActivate($("bfFolder"), async () => {
    if (busy) return;
    try { if (await chooseFolder()) say("保存文件夹已设置。", "ok"); }
    catch (error) { say("选择文件夹失败：" + String(error.message || error), "error"); }
  });

  try {
    ps.action.addNotificationListener(["select", "open", "close"], () => scheduleLive());
  } catch (e) { console.warn("[Bounds Frame] selection listener unavailable", e); }
  root.__boundsFrameActivate = () => { snapshot = null; liveSelection(); };

  loadSettings();
  $("bfSwatch").style.backgroundColor = currentColor;
  $("bfHex").value = currentColor;
  renderChips();
  syncChoices();
  liveSelection();
  restoreFolder();
};

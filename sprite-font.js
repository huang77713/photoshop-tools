/* Original Sprite Font Composer Photoshop algorithms unchanged.
 * Scoped DOM references and standalone UXP panel registration removed. */
module.exports = function mountSpriteFont(root) {
const { app, core, imaging, constants } = require("photoshop");
const { storage } = require("uxp");

const fs = storage.localFileSystem;
const STORAGE_KEY = "spriteFontComposer.libraries.v1";
const SELECTED_KEY = "spriteFontComposer.selectedLibrary.v1";

let libraries = loadLibraries();
let selectedLibraryId = localStorage.getItem(SELECTED_KEY) || (libraries[0] ? libraries[0].id : "");
const previewCache = new Map();
let previewSerial = 0;
let busyPreview = false;

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
  el.className = "status " + type;
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
  queueLibraryPreview();
}
function refreshMappedGlyphLabels() {
  const lib=currentLibrary(),chars=getMappingChars(lib);
  const chips=$("glyphPreview").querySelectorAll(".glyph-char");
  for(let i=0;i<chips.length;i++)chips[i].textContent=chars[i]||"?";
}
function setManagerOpen(open) {
  $("sfManager").style.display=open?"block":"none";
  $("btnManage").textContent=open?"收起设置":"字库设置";
  if(open)queueLibraryPreview();
}
function updateAlignButtons() {
  const selected=root.querySelector('input[name="sfAlign"]:checked');
  const value=selected?selected.value:"center";
  root.querySelectorAll(".sf-align-option").forEach(item=>{
    const control=item.querySelector("input");
    item.classList.toggle("selected",!!control&&control.value===value);
  });
}
function queueLibraryPreview(){
  const lib=currentLibrary();
  const serial=++previewSerial;
  renderComposedPreview();
  if(!lib)return;
  const cache=previewCache.get(lib.id);
  if(cache){renderGlyphImageChips();return;}
  if(busyPreview){return;}
  busyPreview=true;
  setTimeout(async()=>{
    try{await loadGlyphPreviews(lib,serial);}
    catch(e){console.warn("[Sprite Font] Preview failed:",e);
      if(serial===previewSerial)$("previewMessage").textContent="预览图片读取失败，仍可尝试生成："+(e.message||String(e));}
    finally{
      busyPreview=false;
      if(currentLibrary() && !previewCache.has(currentLibrary().id))return;
      if(currentLibrary() && currentLibrary().id!==lib.id)queueLibraryPreview();
    }
  },70);
}
function renderLibraryEditor() {
  const lib = currentLibrary();
  const preview = $("glyphPreview");

  if (!lib) {
    $("libraryName").value = "";
    $("mappingInput").value = "";
    $("glyphCount").textContent = "尚未导入字库";
    preview.className = "glyph-preview empty";
    preview.textContent = "导入一张透明 PNG 字库后，这里会显示自动拆分结果。";
    $("btnDelete").disabled = true;
    $("btnSaveLibrary").disabled = true;
    $("composedPreview").textContent="请先导入字库";
    $("previewDimensions").textContent="";
    $("previewMessage").textContent="";
    return;
  }

  $("btnDelete").disabled = false;
  $("btnSaveLibrary").disabled = false;
  $("libraryName").value = lib.name || "";
  $("mappingInput").value = lib.mapping || "";
  $("glyphCount").textContent = `${lib.boxes.length} 个字符 · ${lib.sourceWidth}×${lib.sourceHeight}px`;

  preview.className = "glyph-preview";
  preview.innerHTML = "";
  const chars = getMappingChars(lib);

  lib.boxes.forEach((box, index) => {
    const chip = document.createElement("div");
    chip.className = "glyph-chip";

    const image=document.createElement("img");
    image.className="sf-glyph-image";
    image.setAttribute("alt","字形 "+(index+1));
    image.style.display="none";
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
  renderComposedPreview();
}

function saveCurrentLibraryEdits() {
  const lib = currentLibrary();
  if (!lib) return;

  lib.name = $("libraryName").value.trim() || stripExtension(lib.fileName);
  lib.mapping = $("mappingInput").value;
  savePreviewSettings(lib);
  saveLibraries();
  renderLibraries();

  const count = getMappingChars(lib).length;
  if (count !== lib.boxes.length) {
    setStatus(`已保存，但映射有 ${count} 个字符，图片识别出 ${lib.boxes.length} 个，请保持数量一致。`, "warning");
  } else {
    setStatus("字库设置已保存。", "success");
  }
}

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
      setStatus(`已识别 ${analysis.boxes.length} 个字符，并自动填写了一个映射草稿。请确认后保存。`, "success");
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
  previewCache.delete(lib.id);
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


function readPreviewPreferences(lib) {
  if(!lib)return;
  $("spacingInput").value=Number.isFinite(Number(lib.spacing))?String(lib.spacing):"0";
  $("scaleInput").value=Number.isFinite(Number(lib.previewScale))?String(lib.previewScale):"100";
  const align=lib.align==="left"||lib.align==="right"?lib.align:"center";
  const radio=root.querySelector('input[name="sfAlign"][value="'+align+'"]');
  if(radio)radio.checked=true;
  updateAlignButtons();
}
function savePreviewSettings(lib) {
  if(!lib)return;
  const spacing=Number($("spacingInput").value);
  const scale=Number($("scaleInput").value);
  lib.spacing=Number.isFinite(spacing)?spacing:0;
  lib.previewScale=Number.isFinite(scale)?scale:100;
  const radio=root.querySelector('input[name="sfAlign"]:checked');
  lib.align=radio?radio.value:"center";
  saveLibraries();
}
function renderGlyphImageChips(){
  const lib=currentLibrary();if(!lib)return;
  const cache=previewCache.get(lib.id);
  const images=$("glyphPreview").querySelectorAll(".sf-glyph-image");
  if(!cache)return;
  for(let i=0;i<images.length;i++){
    const entry=cache[i];
    if(entry){images[i].src=entry.url;images[i].style.display="block";}
  }
}
function getPreviewLayout(lib,text) {
  const chars=Array.from(text),mapping=getMappingChars(lib);
  const boxes=new Map();
  mapping.forEach((ch,i)=>{if(!boxes.has(ch))boxes.set(ch,lib.boxes[i]);});
  const unsupported=Array.from(new Set(chars.filter(ch=>ch!==" "&&!boxes.has(ch))));
  const defined=chars.filter(ch=>ch!==" ").map(ch=>boxes.get(ch)).filter(Boolean);
  const average=defined.length?defined.reduce((a,b)=>a+(b.right-b.left),0)/defined.length:20;
  const spaceWidth=Math.max(1,Math.round(average*0.5));
  const spacing=Number($("spacingInput").value);
  const scale=Number($("scaleInput").value);
  const gap=Number.isFinite(spacing)?spacing:0;
  const zoom=Number.isFinite(scale)?Math.max(10,Math.min(500,scale))/100:1;
  let total=0;
  const pieces=chars.map((ch,i)=>{
    const box=ch===" "?null:boxes.get(ch);
    const width=box?box.right-box.left:spaceWidth;
    const record={ch,box,width,offset:total};
    total+=width;
    if(i<chars.length-1)total+=gap;
    return record;
  });
  const rowHeight=Math.max(1,...defined.map(box=>box.rowBottom-box.rowTop));
  return {pieces,total,rowHeight,zoom,unsupported};
}
function renderComposedPreview(){
  const holder=$("composedPreview"),details=$("previewDimensions"),msg=$("previewMessage");
  holder.innerHTML="";
  details.textContent="";
  const lib=currentLibrary(),text=$("textInput").value;
  if(!lib){holder.textContent="请先导入字库";msg.textContent="";return;}
  if(!text){holder.textContent="输入内容后预览";msg.textContent="";return;}
  const mapping=getMappingChars(lib);
  if(mapping.length!==lib.boxes.length){
    holder.textContent="请先核对字库字符映射";
    msg.textContent="识别了 "+lib.boxes.length+" 个字符，映射有 "+mapping.length+" 个";
    return;
  }
  const layout=getPreviewLayout(lib,text);
  if(layout.unsupported.length){
    holder.textContent="当前字库缺少字符";
    msg.textContent="缺少："+layout.unsupported.join(" ");
    return;
  }
  const cache=previewCache.get(lib.id);
  if(!cache){holder.textContent="正在加载真实字符预览…";msg.textContent="";return;}
  const predictedW=Math.max(1,Math.round(layout.total*layout.zoom));
  const predictedH=Math.max(1,Math.round(layout.rowHeight*layout.zoom));
  details.textContent=predictedW+" × "+predictedH+" px";
  const areaWidth=Math.max(90,holder.clientWidth-20),areaHeight=Math.max(70,holder.clientHeight-20);
  const fit=Math.min(1,areaWidth/Math.max(1,predictedW),areaHeight/Math.max(1,predictedH));
  const rasterScale=layout.zoom*fit;
  const row=document.createElement("div");
  row.className="sf-composed-row";
  row.style.width=Math.max(1,Math.round(layout.total*rasterScale))+"px";
  row.style.height=Math.max(1,Math.round(layout.rowHeight*rasterScale))+"px";
  row.style.position="relative";
  const charIndex=new Map();
  mapping.forEach((ch,i)=>charIndex.set(ch,i));
  for(const piece of layout.pieces){
    if(piece.ch===" ")continue;
    const imgData=cache[charIndex.get(piece.ch)];
    if(!imgData)continue;
    const img=document.createElement("img");
    img.src=imgData.url;
    img.className="sf-composed-glyph";
    img.style.position="absolute";
    img.style.left=Math.round(piece.offset*rasterScale)+"px";
    img.style.top=Math.round((piece.box.top-piece.box.rowTop)*rasterScale)+"px";
    img.style.width=Math.max(1,Math.round(piece.width*rasterScale))+"px";
    img.style.height=Math.max(1,Math.round((piece.box.bottom-piece.box.top)*rasterScale))+"px";
    row.appendChild(img);
  }
  holder.appendChild(row);
  msg.textContent=fit<1?"预览已缩小适配面板；生成尺寸不受影响":"";
}
async function loadGlyphPreviews(lib,serial){
  let entry;
  try{entry=await fs.getEntryForPersistentToken(lib.token);}
  catch(e){throw new Error("原字库已移动或权限失效，请重新导入");}
  const images=[];
  await core.executeAsModal(async()=>{
    const atlas=await app.open(entry);
    try{
      const max=Math.min(60,lib.boxes.length);
      for(let i=0;i<max;i++){
        const box=lib.boxes[i];
        const glyph=await readGlyphFromAtlas(atlas.id,box);
        const n=glyph.width*glyph.height;
        const rgb=new Uint8Array(n*3);
        for(let j=0;j<n;j++){
          const p=j*glyph.components,o=j*3;
          const a=glyph.components===4?glyph.data[p+3]/255:1;
          rgb[o]=Math.round((glyph.data[p]||0)*a+35*(1-a));
          rgb[o+1]=Math.round((glyph.data[p+1]||0)*a+33*(1-a));
          rgb[o+2]=Math.round((glyph.data[p+2]||0)*a+42*(1-a));
        }
        let data=null;
        try{
          data=await imaging.createImageDataFromBuffer(rgb,{width:glyph.width,height:glyph.height,components:3,chunky:true,colorSpace:"RGB",colorProfile:"sRGB IEC61966-2.1"});
          const jpeg=await imaging.encodeImageData({imageData:data,base64:true});
          images.push({url:"data:image/jpeg;base64,"+jpeg,width:glyph.width,height:glyph.height});
        }finally{if(data)data.dispose();}
      }
    }finally{atlas.closeWithoutSaving();}
  },{commandName:"读取图片字预览"});
  previewCache.set(lib.id,images);
  if(currentLibrary()&&currentLibrary().id===lib.id){
    renderGlyphImageChips();
    renderComposedPreview();
  }
}
async function placeGlyph(targetDoc, glyph, layerName, left, top) {
  const layer = await targetDoc.createPixelLayer({ name: layerName });
  const options = {
    width: glyph.width,
    height: glyph.height,
    components: glyph.components,
    chunky: true,
    colorSpace: glyph.colorSpace || "RGB"
  };
  if (glyph.colorProfile) options.colorProfile = glyph.colorProfile;

  const imageData = await imaging.createImageDataFromBuffer(glyph.data, options);
  try {
    await imaging.putPixels({
      documentID: targetDoc.id,
      layerID: layer.id,
      imageData,
      replace: true,
      targetBounds: { left: Math.round(left), top: Math.round(top) },
      commandName: "放置图片字"
    });
  } finally {
    imageData.dispose();
  }
  return layer;
}

async function generateText() {
  const lib = currentLibrary();
  if (!lib) {
    setStatus("请先导入一个字库。", "error");
    return;
  }

  const text = $("textInput").value;
  if (!text) {
    setStatus("请输入要生成的内容。", "error");
    return;
  }

  let charMap;
  try {
    charMap = buildCharMap(lib);
  } catch (e) {
    setStatus(e.message, "error");
    return;
  }

  const chars = Array.from(text);
  const unsupported = Array.from(new Set(chars.filter((ch) => ch !== " " && !charMap.has(ch))));
  if (unsupported.length) {
    setStatus(`当前字库不包含：${unsupported.join(" ")}`, "error");
    return;
  }

  if (!app.documents.length) {
    setStatus("请先打开一个 Photoshop 文档，再生成图片字。", "error");
    return;
  }

  const targetDoc = app.activeDocument;
  const targetDocId = targetDoc.id;
  const spacing = Number($("spacingInput").value || 0);
  const scale = Math.max(10, Math.min(500, Number($("scaleInput").value || 100)));
  const autoGroup = $("groupCheck").checked;
  const alignInput=root.querySelector('input[name="sfAlign"]:checked');
  const horizontalAlign=alignInput?alignInput.value:"center";

  let entry;
  try {
    entry = await fs.getEntryForPersistentToken(lib.token);
  } catch (e) {
    setStatus("原字库图片已经移动、删除或权限失效。请重新导入这张字库图片。", "error");
    return;
  }

  setStatus("正在生成图片字图层…");

  try {
    await core.executeAsModal(async () => {
      const atlasDoc = await app.open(entry);
      const glyphCache = new Map();

      try {
        for (const ch of chars) {
          if (ch === " " || glyphCache.has(ch)) continue;
          glyphCache.set(ch, await readGlyphFromAtlas(atlasDoc.id, charMap.get(ch)));
        }
      } finally {
        atlasDoc.closeWithoutSaving();
      }

      const doc = getOpenDocumentById(targetDocId);
      if (!doc) throw new Error("目标 Photoshop 文档已经关闭。请重新打开后再试。");

      const mappedBoxes = chars.filter((ch) => ch !== " ").map((ch) => charMap.get(ch));
      const averageWidth = mappedBoxes.length
        ? mappedBoxes.reduce((sum, b) => sum + (b.right - b.left), 0) / mappedBoxes.length
        : 20;
      const spaceWidth = Math.max(1, Math.round(averageWidth * 0.5));

      let totalWidth = 0;
      chars.forEach((ch, index) => {
        if (ch === " ") totalWidth += spaceWidth;
        else {
          const box = charMap.get(ch);
          totalWidth += box.right - box.left;
        }
        if (index < chars.length - 1) totalWidth += spacing;
      });

      let layoutHeight = 0;
      mappedBoxes.forEach((box) => {
        layoutHeight = Math.max(layoutHeight, box.rowBottom - box.rowTop);
      });
      layoutHeight = Math.max(layoutHeight, 1);

      const scaledWidth=totalWidth*(scale/100);
      const leftEdge=horizontalAlign==="left"?0:horizontalAlign==="right"?doc.width-scaledWidth:(doc.width-scaledWidth)/2;
      let cursorX=Math.round(leftEdge+(scaledWidth-totalWidth)/2);
      const startY = Math.round((doc.height - layoutHeight) / 2);
      const createdLayers = [];

      for (let index = 0; index < chars.length; index++) {
        const ch = chars[index];
        if (ch === " ") {
          cursorX += spaceWidth + spacing;
          continue;
        }

        const box = charMap.get(ch);
        const glyph = glyphCache.get(ch);
        const y = startY + (box.top - box.rowTop) + glyph.shiftY;
        const x = cursorX + glyph.shiftX;
        const layer = await placeGlyph(doc, glyph, `${index + 1}_${ch}`, x, y);
        createdLayers.push(layer);
        cursorX += (box.right - box.left) + spacing;
      }

      if (!createdLayers.length) throw new Error("没有可以生成的字符。");

      let group = null;
      if (autoGroup || scale !== 100) {
        group = await doc.createLayerGroup({
          name: text,
          fromLayers: createdLayers
        });
      }

      if (scale !== 100) {
        const transformTarget = group || createdLayers[0];
        await transformTarget.scale(
          scale,
          scale,
          constants.AnchorPosition.MIDDLECENTER,
          { interpolation: constants.InterpolationMethod.BICUBIC }
        );
      }
    }, { commandName: `生成图片字 ${text}` });

    savePreviewSettings(lib);
    setStatus(`“${text}” 已生成：每个字符都是独立图层。`, "success");
  } catch (e) {
    console.error(e);
    setStatus("生成失败：" + (e.message || String(e)), "error");
  }
}

function wireEvents() {
  $("btnImport").addEventListener("click", importLibrary);
  $("btnDelete").addEventListener("click", deleteLibrary);
  $("btnSaveLibrary").addEventListener("click", saveCurrentLibraryEdits);
  $("btnGenerate").addEventListener("click", generateText);
  $("btnManage").addEventListener("click",()=>setManagerOpen($("sfManager").style.display==="none"));
  ["textInput","spacingInput","scaleInput"].forEach(id=>{
    $(id).addEventListener("input",()=>{
      renderComposedPreview();
      if(id!=="textInput")savePreviewSettings(currentLibrary());
    });
  });
  root.querySelectorAll(".sf-align-option").forEach(item=>{
    item.addEventListener("click",()=>{
      const radio=item.querySelector('input[name="sfAlign"]');
      if(radio)radio.checked=true;
      updateAlignButtons();
      savePreviewSettings(currentLibrary());
    });
  });

  $("librarySelect").addEventListener("change", (event) => {
    selectedLibraryId = event.target.value;
    localStorage.setItem(SELECTED_KEY, selectedLibraryId || "");
    renderLibraryEditor();
    readPreviewPreferences(currentLibrary());
    queueLibraryPreview();
  });

  $("mappingInput").addEventListener("input", () => {
    const lib = currentLibrary();
    if (!lib) return;
    lib.mapping = $("mappingInput").value;
    const chars = getMappingChars(lib);
    const chips = $("glyphPreview").querySelectorAll(".glyph-char");
    for (let i = 0; i < chips.length; i++) {
      chips[i].textContent = chars[i] || "?";
    }
    renderComposedPreview();
  });
}

wireEvents();
renderLibraries();
updateAlignButtons();
setManagerOpen(false);
};

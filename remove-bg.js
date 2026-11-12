/* Integrated from ps-remove-bg-tool. Photoshop processing logic unchanged.
   DOM queries are isolated to this tool's own view. */
module.exports = function mount(root) {
const { app, core, action, constants, imaging } = require("photoshop");

const STORAGE = {
  groupName: "transparentSplit.test.groupName",
  layerPrefix: "transparentSplit.test.layerPrefix",
  minAreaPercent: "transparentSplit.test.minAreaPercent",
  padding: "transparentSplit.test.padding"
};

// 只用于识别元素，不改写原图像素。
// 稍微忽略极低 Alpha 的残留，减少柔边/脏点把两个元素误连在一起。
const ALPHA_THRESHOLD = 8;
const MAX_COMPONENTS = 100;

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

function safeName(value, fallback) {
  const name = String(value || "").trim();
  return name || fallback;
}

function readNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function getCurrentLayer() {
  if (!app.documents || app.documents.length === 0) {
    throw new Error("请先打开一个 Photoshop 文档。");
  }

  const doc = app.activeDocument;
  const selected = doc.activeLayers;

  if (!selected || selected.length !== 1) {
    throw new Error("请只选中 1 个已经去好背景的透明图片图层。");
  }

  const layer = selected[0];
  if (layer.kind === constants.LayerKind.GROUP) {
    throw new Error("当前选中的是图层组。请选中真正的透明图片图层。");
  }

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
    $("layerStatus").textContent = `✓ ${layer.name} · ${layerKindLabel(layer)}`;
    $("layerStatus").className = "status success";
    return true;
  } catch (err) {
    $("layerStatus").textContent = formatError(err);
    $("layerStatus").className = "status error";
    return false;
  }
}

async function selectLayerById(layerId) {
  await action.batchPlay(
    [{
      _obj: "select",
      _target: [{ _ref: "layer", _id: layerId }],
      makeVisible: false,
      _options: { dialogOptions: "dontDisplay" }
    }],
    {}
  );
}

async function convertActiveLayerToSmartObject() {
  await action.batchPlay(
    [{
      _obj: "newPlacedLayer",
      _options: { dialogOptions: "dontDisplay" }
    }],
    {}
  );
}

async function layerViaCopy() {
  await action.batchPlay(
    [{
      _obj: "copyToLayer",
      _options: { dialogOptions: "dontDisplay" }
    }],
    {}
  );
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

async function cleanupCreatedLayers(doc, createdLayerIds, sourceLayerId) {
  if (!doc || !createdLayerIds || createdLayerIds.size === 0) return;

  try {
    app.activeDocument = doc;
    const allLayers = flattenLayers(doc.layers || []);
    const targets = allLayers.filter(
      (layer) => createdLayerIds.has(layer.id) && layer.id !== sourceLayerId
    );

    for (const layer of targets) {
      try {
        await layer.delete();
      } catch (_) {}
    }
  } catch (_) {}
}

// 对原图副本做“空图层 + 向下合并”，只为得到稳定的真实透明像素工作层。
// 原始图层本身完全不动。这个步骤也能把智能对象/蒙版的可见结果烘焙到临时像素层。
async function makeTransparentWorkingCopy(doc, sourceLayer, createdLayerIds) {
  const working = await sourceLayer.duplicate();
  if (!working || working.id === sourceLayer.id) {
    throw new Error("复制临时工作层失败。");
  }

  createdLayerIds.add(working.id);

  try { working.allLocked = false; } catch (_) {}
  try { working.positionLocked = false; } catch (_) {}

  working.visible = true;
  working.name = "_SPLIT_WORKING";

  const empty = await doc.createLayer({ name: "_SPLIT_EMPTY_HELPER" });
  createdLayerIds.add(empty.id);
  empty.visible = true;
  empty.move(working, constants.ElementPlacement.PLACEBEFORE);

  await selectLayerById(empty.id);

  let merged = null;
  try {
    merged = await empty.merge();
  } catch (err) {
    throw new Error(`生成透明临时像素层失败：${formatError(err)}`);
  }

  if (!merged) {
    const active = doc.activeLayers || [];
    if (active.length === 1) merged = active[0];
  }

  if (!merged) {
    throw new Error("无法取得透明临时像素层。");
  }

  createdLayerIds.add(merged.id);
  merged.name = "_TRANSPARENT_SPLIT_WORKING";
  merged.visible = true;
  return merged;
}

function buildConnectedComponents(pixelData, width, height, components, minArea) {
  if (components !== 4) {
    throw new Error(`透明像素读取异常：期望 RGBA 4 通道，实际 ${components} 通道。`);
  }

  const runs = [];
  const parent = [];
  const rank = [];

  function alphaAt(x, y) {
    return pixelData[(y * width + x) * 4 + 3];
  }

  function find(i) {
    let root = i;
    while (parent[root] !== root) root = parent[root];

    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }

    return root;
  }

  function union(a, b) {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;

    if (rank[ra] < rank[rb]) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }

    parent[rb] = ra;
    if (rank[ra] === rank[rb]) rank[ra] += 1;
  }

  let previousRow = [];
  let visiblePixels = 0;
  let transparentPixels = 0;

  for (let y = 0; y < height; y += 1) {
    const currentRow = [];
    let x = 0;

    while (x < width) {
      while (x < width && alphaAt(x, y) < ALPHA_THRESHOLD) {
        transparentPixels += 1;
        x += 1;
      }

      if (x >= width) break;

      const start = x;
      while (x < width && alphaAt(x, y) >= ALPHA_THRESHOLD) {
        visiblePixels += 1;
        x += 1;
      }
      const end = x - 1;

      const id = runs.length;
      runs.push({ y, start, end });
      parent[id] = id;
      rank[id] = 0;
      currentRow.push(id);
    }

    let p = 0;

    for (const currentId of currentRow) {
      const current = runs[currentId];

      while (
        p < previousRow.length &&
        runs[previousRow[p]].end < current.start - 1
      ) {
        p += 1;
      }

      let q = p;
      while (
        q < previousRow.length &&
        runs[previousRow[q]].start <= current.end + 1
      ) {
        union(currentId, previousRow[q]);
        q += 1;
      }
    }

    previousRow = currentRow;
  }

  if (visiblePixels === 0) {
    throw new Error("当前图层没有检测到可见内容。");
  }

  const map = new Map();

  for (let i = 0; i < runs.length; i += 1) {
    const root = find(i);
    const run = runs[i];
    const runArea = run.end - run.start + 1;

    let item = map.get(root);
    if (!item) {
      item = {
        area: 0,
        minX: run.start,
        maxX: run.end,
        minY: run.y,
        maxY: run.y
      };
      map.set(root, item);
    }

    item.area += runArea;
    item.minX = Math.min(item.minX, run.start);
    item.maxX = Math.max(item.maxX, run.end);
    item.minY = Math.min(item.minY, run.y);
    item.maxY = Math.max(item.maxY, run.y);
  }

  const items = Array.from(map.values()).filter((item) => item.area >= minArea);

  return {
    items,
    hasTransparentGap: transparentPixels > 0
  };
}

function sortReadingOrder(items) {
  items.sort((a, b) => {
    const acy = (a.minY + a.maxY) / 2;
    const bcy = (b.minY + b.maxY) / 2;
    const ah = a.maxY - a.minY + 1;
    const bh = b.maxY - b.minY + 1;
    const tolerance = Math.max(12, Math.min(ah, bh) * 0.45);

    if (Math.abs(acy - bcy) <= tolerance) {
      return a.minX - b.minX;
    }

    return acy - bcy;
  });
}

function safePadding(item, items, index, requestedPadding) {
  let leftGap = Infinity;
  let rightGap = Infinity;
  let topGap = Infinity;
  let bottomGap = Infinity;

  const rect = {
    l: item.minX,
    t: item.minY,
    r: item.maxX + 1,
    b: item.maxY + 1
  };

  for (let i = 0; i < items.length; i += 1) {
    if (i === index) continue;

    const other = {
      l: items[i].minX,
      t: items[i].minY,
      r: items[i].maxX + 1,
      b: items[i].maxY + 1
    };

    if (!(other.b <= rect.t || other.t >= rect.b)) {
      if (other.r <= rect.l) leftGap = Math.min(leftGap, rect.l - other.r);
      if (other.l >= rect.r) rightGap = Math.min(rightGap, other.l - rect.r);
    }

    if (!(other.r <= rect.l || other.l >= rect.r)) {
      if (other.b <= rect.t) topGap = Math.min(topGap, rect.t - other.b);
      if (other.t >= rect.b) bottomGap = Math.min(bottomGap, other.t - rect.b);
    }
  }

  function padFor(gap) {
    if (!Number.isFinite(gap)) return requestedPadding;
    return Math.min(requestedPadding, Math.max(0, Math.floor(gap / 2)));
  }

  return {
    left: padFor(leftGap),
    right: padFor(rightGap),
    top: padFor(topGap),
    bottom: padFor(bottomGap)
  };
}

async function readTransparentPixels(doc, layer) {
  const result = await imaging.getPixels({
    documentID: doc.id,
    layerID: layer.id,
    colorSpace: "RGB",
    componentSize: 8,
    applyAlpha: false
  });

  if (!result || !result.imageData) {
    throw new Error("无法读取当前透明图层的像素。");
  }

  const imageData = result.imageData;
  const width = imageData.width;
  const height = imageData.height;
  const components = imageData.components;
  const sourceBounds = result.sourceBounds;

  if (!imageData.hasAlpha || components !== 4) {
    try { imageData.dispose(); } catch (_) {}
    throw new Error("当前图层没有可读取的透明 Alpha。请先手动去掉背景后再运行。");
  }

  const data = await imageData.getData({ chunky: true });
  try { imageData.dispose(); } catch (_) {}

  return { data, width, height, components, sourceBounds };
}

async function duplicateRectangleFromWorkingLayer(
  doc,
  workingLayer,
  sourcePixels,
  item,
  allItems,
  itemIndex,
  paddingPx,
  layerName
) {
  const padding = safePadding(item, allItems, itemIndex, paddingPx);

  const sourceBounds = sourcePixels.sourceBounds;
  const docWidth = Number(doc.width) || Number(sourceBounds.right);
  const docHeight = Number(doc.height) || Number(sourceBounds.bottom);

  const left = Math.max(
    0,
    Math.floor(sourceBounds.left + item.minX - padding.left)
  );
  const top = Math.max(
    0,
    Math.floor(sourceBounds.top + item.minY - padding.top)
  );
  const right = Math.min(
    docWidth,
    Math.ceil(sourceBounds.left + item.maxX + 1 + padding.right)
  );
  const bottom = Math.min(
    docHeight,
    Math.ceil(sourceBounds.top + item.maxY + 1 + padding.bottom)
  );

  if (!(right > left && bottom > top)) {
    throw new Error(`${layerName} 的拆分范围无效。`);
  }

  await selectLayerById(workingLayer.id);

  await doc.selection.selectRectangle(
    { top, left, bottom, right },
    constants.SelectionType.REPLACE,
    0,
    false
  );

  await layerViaCopy();

  const active = doc.activeLayers || [];
  if (active.length !== 1 || active[0].id === workingLayer.id) {
    throw new Error(`${layerName} 没有成功生成独立图层。`);
  }

  const newLayer = active[0];
  newLayer.name = layerName;

  try { await doc.selection.deselect(); } catch (_) {}

  return newLayer;
}


let latestAnalysis=null;
let previewRequest=0;
let previewTimer=null;
let analyzing=false;
let splitting=false;
function selectedKey(){
  try{
    const doc=app.activeDocument, layers=doc&&doc.activeLayers;
    return doc&&layers&&layers.length===1?doc.id+":"+layers[0].id:"";
  }catch(_){return "";}
}
function isVisible(){return root.style.display!=="none";}
function setOutputType(mode){
  root.querySelectorAll(".ts-output-option").forEach(item=>{
    const active=item.dataset.output===mode;
    item.classList.toggle("ts-selected",active);
    const input=item.querySelector('input[name="splitOutput"]');
    if(input)input.checked=active;
  });
  updateRunButton();
}
function getOutputType(){
  const el=root.querySelector('input[name="splitOutput"]:checked');
  return el&&el.value==="pixel"?"pixel":"smart";
}
function updateRunButton(){
  const button=$("runBtn");
  if(splitting){button.disabled=true;button.textContent="正在拆分…";return;}
  const ready=latestAnalysis&&latestAnalysis.key===selectedKey()&&latestAnalysis.items.length>0;
  button.disabled=!ready;
  button.textContent=ready?"拆分 "+latestAnalysis.items.length+" 个对象":"请先识别透明对象";
}
function clearPreview(message){
  latestAnalysis=null;
  $("splitPreviewImage").removeAttribute("src");
  $("splitPreviewStage").style.display="none";
  $("splitPreviewMarkers").innerHTML="";
  $("splitPreviewPlaceholder").style.display="block";
  $("splitPreviewPlaceholder").textContent=message||"请选择透明图层";
  $("detectedCount").textContent="未识别";
  $("splitPreviewInfo").textContent="只读检测，不修改原始图层";
  updateRunButton();
}
function scheduleAnalysis(force){
  if(!isVisible()||splitting)return;
  if(previewTimer!==null)clearTimeout(previewTimer);
  const request=++previewRequest;
  previewTimer=setTimeout(()=>{
    previewTimer=null;
    if(!isVisible()||splitting)return;
    const key=selectedKey();
    const setting=readSettings().minAreaPercent;
    if(!force&&latestAnalysis&&latestAnalysis.key===key&&latestAnalysis.minAreaPercent===setting)return;
    if(analyzing)return;
    analyzePreview(request);
  },260);
}
function makePreviewBytes(data,width,height,components,w,h){
  const raw=new Uint8Array(w*h*3);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const sx=Math.min(width-1,Math.floor((x+.5)*width/w));
    const sy=Math.min(height-1,Math.floor((y+.5)*height/h));
    const p=(sy*width+sx)*components, d=(y*w+x)*3;
    const a=data[p+3]/255;
    const bg=((Math.floor(x/10)+Math.floor(y/10))%2)?48:56;
    for(let k=0;k<3;k++)raw[d+k]=Math.round(data[p+k]*a+bg*(1-a));
  }
  return raw;
}
function renderDetectedBoxes(items,width,height,previewWidth,previewHeight){
  const layer=$("splitPreviewMarkers");
  layer.innerHTML="";
  const scaleX=previewWidth/width,scaleY=previewHeight/height;
  items.forEach((item,i)=>{
    const el=document.createElement("div");
    el.className="ts-detection-box";
    el.style.left=(item.minX*scaleX)+"px";
    el.style.top=(item.minY*scaleY)+"px";
    el.style.width=Math.max(2,(item.maxX-item.minX+1)*scaleX)+"px";
    el.style.height=Math.max(2,(item.maxY-item.minY+1)*scaleY)+"px";
    const num=document.createElement("span");
    num.className="ts-detection-number";
    num.textContent=String(i+1).padStart(2,"0");
    el.appendChild(num);
    layer.appendChild(el);
  });
}
async function analyzePreview(request){
  if(analyzing||splitting)return;
  analyzing=true;
  let pixel=null, image=null;
  try{
    const {doc,layer}=getCurrentLayer();
    const key=doc.id+":"+layer.id;
    refreshLayerStatus();
    $("detectedCount").textContent="识别中…";
    $("splitPreviewInfo").textContent="正在读取透明像素";
    const pixels=await readTransparentPixels(doc,layer);
    if(request!==previewRequest||key!==selectedKey())return;
    const percent=readSettings().minAreaPercent;
    const minArea=Math.max(1,Math.floor(pixels.width*pixels.height*percent/100));
    const result=buildConnectedComponents(pixels.data,pixels.width,pixels.height,pixels.components,minArea);
    sortReadingOrder(result.items);
    if(result.items.length>MAX_COMPONENTS)throw new Error("识别到过多碎片，请在高级设置中提高最小面积");
    const previewEl=$("splitPreview");
    const maxWidth=Math.max(100,Math.min(460,(previewEl.clientWidth||340)-24));
    const maxHeight=195;
    const k=Math.min(maxWidth/pixels.width,maxHeight/pixels.height,1);
    const w=Math.max(1,Math.round(pixels.width*k)),h=Math.max(1,Math.round(pixels.height*k));
    const rgb=makePreviewBytes(pixels.data,pixels.width,pixels.height,pixels.components,w,h);
    image=await imaging.createImageDataFromBuffer(rgb,{width:w,height:h,components:3,chunky:true,colorSpace:"RGB",colorProfile:"sRGB IEC61966-2.1"});
    const jpg=await imaging.encodeImageData({imageData:image,base64:true});
    if(request!==previewRequest||key!==selectedKey())return;
    const img=$("splitPreviewImage");
    img.style.width=w+"px";img.style.height=h+"px";
    img.src="data:image/jpeg;base64,"+jpg;
    $("splitPreviewStage").style.width=w+"px";
    $("splitPreviewStage").style.height=h+"px";
    $("splitPreviewStage").style.display="block";
    $("splitPreviewPlaceholder").style.display="none";
    renderDetectedBoxes(result.items,pixels.width,pixels.height,w,h);
    latestAnalysis={key,items:result.items,minAreaPercent:percent};
    $("detectedCount").textContent=result.items.length+" 个对象";
    $("splitPreviewInfo").textContent=result.items.length===0?"没有识别到独立元素，请调整最小面积":result.items.length===1?"仅识别到一个整体，请检查透明间隔":"已标出 "+result.items.length+" 个识别区域 · 原图未修改";
    updateRunButton();
  }catch(e){
    clearPreview("暂时无法预览该图层");
    $("splitPreviewInfo").textContent=formatError(e)+" · 请确认图层有真实透明像素";
    refreshLayerStatus();
  }finally{
    if(image)try{image.dispose();}catch(_){}
    analyzing=false;
    if(request!==previewRequest&&isVisible()&&!splitting)scheduleAnalysis(false);
  }
}

function restoreSettings() {
  const groupName = localStorage.getItem(STORAGE.groupName);
  const layerPrefix = localStorage.getItem(STORAGE.layerPrefix);
  const minAreaPercent = localStorage.getItem(STORAGE.minAreaPercent);
  const padding = localStorage.getItem(STORAGE.padding);

  if (groupName !== null) $("groupName").value = groupName;
  if (layerPrefix !== null) $("layerPrefix").value = layerPrefix;
  if (minAreaPercent !== null) $("minAreaPercent").value = minAreaPercent;
  if (padding !== null) $("padding").value = padding;
}

function saveSettings() {
  localStorage.setItem(STORAGE.groupName, $("groupName").value);
  localStorage.setItem(STORAGE.layerPrefix, $("layerPrefix").value);
  localStorage.setItem(STORAGE.minAreaPercent, $("minAreaPercent").value);
  localStorage.setItem(STORAGE.padding, $("padding").value);
}

function readSettings() {
  return {
    groupName: safeName($("groupName").value, "Split_Objects"),
    layerPrefix: safeName($("layerPrefix").value, "Object"),
    minAreaPercent: readNumber($("minAreaPercent").value, 0.002, 0, 10),
    padding: Math.round(readNumber($("padding").value, 8, 0, 200))
  };
}

async function splitObjects() {
  if(splitting||analyzing)return;
  const key=selectedKey();
  if(!latestAnalysis||latestAnalysis.key!==key){
    setMessage("请先确认当前图层的识别预览，再点击拆分。","error");
    scheduleAnalysis(true);
    return;
  }
  const button=$("runBtn");
  splitting=true;
  updateRunButton();

  let doc = null;
  let sourceLayer = null;
  let stage = "读取当前图层";
  const createdLayerIds = new Set();

  try {
    const source = getCurrentLayer();
    doc = source.doc;
    sourceLayer = source.layer;

    const sourceLayerId = sourceLayer.id;
    const sourceName = sourceLayer.name;
    const sourceVisibleBefore = sourceLayer.visible;
    const settings=readSettings();
    const outputType=getOutputType();
    if(latestAnalysis.minAreaPercent!==settings.minAreaPercent)throw new Error("识别参数已改变，请重新识别后拆分");
    saveSettings();

    let finalGroup = null;
    let elementCount = 0;
    let noTransparentGap = false;

    setMessage("正在分析当前透明图层…", "muted");

    await core.executeAsModal(async (executionContext) => {
      app.activeDocument = doc;

      stage = "复制透明图层到临时工作层";
      executionContext.reportProgress({ value: 0.08, commandName: stage });
      const workingLayer = await makeTransparentWorkingCopy(
        doc,
        sourceLayer,
        createdLayerIds
      );

      stage = "读取透明区域";
      executionContext.reportProgress({ value: 0.22, commandName: stage });
      const sourcePixels = await readTransparentPixels(doc, workingLayer);

      const minArea = Math.max(
        1,
        Math.floor(
          sourcePixels.width *
          sourcePixels.height *
          (settings.minAreaPercent / 100)
        )
      );

      stage = "识别独立元素";
      executionContext.reportProgress({ value: 0.36, commandName: stage });
      const analysis = buildConnectedComponents(
        sourcePixels.data,
        sourcePixels.width,
        sourcePixels.height,
        sourcePixels.components,
        minArea
      );

      const objects = analysis.items;
      noTransparentGap = !analysis.hasTransparentGap;

      if (objects.length === 0) {
        throw new Error("没有检测到可拆分的元素。可以把“最小元素面积”调小后重试。");
      }

      if (objects.length > MAX_COMPONENTS) {
        throw new Error(
          `检测到 ${objects.length} 个独立碎片，数量过多。请提高“最小元素面积”过滤小残渣。`
        );
      }

      sortReadingOrder(objects);
      elementCount = objects.length;

      stage = `创建 ${elementCount} 个独立图层`;
      executionContext.reportProgress({ value: 0.48, commandName: stage });

      finalGroup = await doc.createLayerGroup({ name: settings.groupName });
      createdLayerIds.add(finalGroup.id);

      // 倒序创建，最终在图层面板里从上到下保持 01、02、03…
      for (let i = objects.length - 1; i >= 0; i -= 1) {
        const number = String(i + 1).padStart(2, "0");
        const layerName = `${settings.layerPrefix}_${number}`;

        stage = `拆分 ${layerName}`;
        const done = objects.length - i;
        const progress = 0.48 + (done / objects.length) * 0.40;
        executionContext.reportProgress({ value: progress, commandName: stage });

        const pixelLayer = await duplicateRectangleFromWorkingLayer(
          doc,
          workingLayer,
          sourcePixels,
          objects[i],
          objects,
          i,
          settings.padding,
          layerName
        );

        createdLayerIds.add(pixelLayer.id);

        let outputLayer=pixelLayer;
        if(outputType==="smart"){
          await selectLayerById(pixelLayer.id);
          await convertActiveLayerToSmartObject();
          const active=doc.activeLayers||[];
          if(active.length!==1)throw new Error(`${layerName} 转智能对象后无法取得结果层。`);
          outputLayer=active[0];
          createdLayerIds.add(outputLayer.id);
        }
        outputLayer.name=layerName;
        outputLayer.move(finalGroup,constants.ElementPlacement.PLACEINSIDE);
      }

      try { await doc.selection.deselect(); } catch (_) {}

      stage = "删除临时工作层";
      executionContext.reportProgress({ value: 0.92, commandName: stage });
      try {
        await workingLayer.delete();
      } catch (err) {
        throw new Error(`拆分已完成，但临时工作层清理失败：${formatError(err)}`);
      }

      // 原始图层严格保持原来的名称和可见状态。
      if (sourceLayer.name !== sourceName) {
        throw new Error("保护检查失败：原始图层名称被意外修改。");
      }
      if (sourceLayer.visible !== sourceVisibleBefore) {
        sourceLayer.visible = sourceVisibleBefore;
        throw new Error("保护检查失败：原始图层可见状态被意外修改，已恢复。");
      }

      await selectLayerById(finalGroup.id);
      executionContext.reportProgress({ value: 1, commandName: "完成" });
    }, { commandName: "透明对象自动拆分" });

    const extra = noTransparentGap
      ? " 当前图层没有明显透明间隔，因此只可能识别为一个整体。"
      : "";

    setMessage(
      `✓ 完成：拆出 ${elementCount} 个${outputType==="smart"?"智能对象":"像素图层"}。原始图层保持不变。${extra}`,
      "success"
    );
  } catch (err) {
    if (doc && sourceLayer) {
      try {
        await core.executeAsModal(async () => {
          try { await doc.selection.deselect(); } catch (_) {}
          await cleanupCreatedLayers(doc, createdLayerIds, sourceLayer.id);
          app.activeDocument = doc;
          await selectLayerById(sourceLayer.id);
        }, { commandName: "清理失败的拆分结果" });
      } catch (_) {}
    }

    setMessage(`失败[${stage}]：${formatError(err)}`, "error");
    console.error(err);
  } finally {
    splitting=false;
    latestAnalysis=null;
    refreshLayerStatus();
    scheduleAnalysis(true);
    updateRunButton();
  }
}

function wireEvents() {
  $("refreshLayerBtn").addEventListener("click",()=>{refreshLayerStatus();scheduleAnalysis(true);});
  $("runBtn").addEventListener("click",splitObjects);
  $("advancedToggle").addEventListener("click",()=>{
    const panel=$("advancedPanel");
    const open=panel.style.display==="none";
    panel.style.display=open?"block":"none";
    $("advancedToggle").setAttribute("aria-expanded",open?"true":"false");
    $("advancedArrow").textContent=open?"−":"+";
  });
  root.querySelectorAll(".ts-output-option").forEach(el=>{
    function activate(){
      setOutputType(el.dataset.output);
    }
    el.addEventListener("click",activate);
    el.addEventListener("keydown",e=>{
      if(e.key===" "||e.key==="Enter"){e.preventDefault();activate();}
    });
  });
  ["minAreaPercent","padding"].forEach(id=>{
    $(id).addEventListener("change",()=>{saveSettings();scheduleAnalysis(true);});
  });

  ["groupName", "layerPrefix", "minAreaPercent", "padding"].forEach((id) => {
    $(id).addEventListener("change", saveSettings);
  });
}

function init() {
  restoreSettings();
  wireEvents();
  refreshLayerStatus();
  setOutputType("smart");
  clearPreview("选择透明图层后自动识别");
  root.__transparentSplitActivate=function(){
    refreshLayerStatus();
    scheduleAnalysis(false);
  };
  try{
    action.addNotificationListener(["select","open","close"],(eventName,descriptor)=>{
      if(!isVisible()||splitting)return;
      if(eventName==="select"){
        const targets=descriptor&&descriptor._target;
        if(Array.isArray(targets)&&!targets.some(x=>x&&(x._ref==="layer"||x._ref==="document")))return;
      }
      scheduleAnalysis(false);
    });
  }catch(e){console.warn("[Transparent Split] selection listener unavailable",e);}
  scheduleAnalysis(true);
}

init();

};

/* Batch Visible Resize - Photoshop UXP. Completely isolated from Smart Arrange.
   v2: measuring is still alpha-based (direct layer read, temporary composite copy for
   groups), now at full resolution up to 4096 px and including parts outside the canvas.
   Added: reference-object and percentage targets, 9-point anchor, interpolation choice,
   per-object plan list, post-resize check with integer correction, selection-safe scaling,
   automatic rollback on failure, auto read on selection change. */
module.exports=function initVisibleResize(root){
"use strict";
const ps=require("photoshop"),app=ps.app,core=ps.core,imaging=ps.imaging,constants=ps.constants,action=ps.action;
const $=id=>root.querySelector("#"+id);
const MAX_READ=4096;
const state={basis:"size",ref:"first",method:"contain",anchor:"0.5,0.5",interp:"smooth",resetScope:"selected"};
let selection=[],documentId=null,working=false,alphaThreshold=8,check=null,resetArmed=null,ignoreSelectUntil=0;
const PREFS_KEY="visibleResize.v2.prefs";
function loadPrefs(){try{const v=JSON.parse(localStorage.getItem(PREFS_KEY)||"{}");Object.keys(state).forEach(k=>{if(typeof v[k]==="string")state[k]=v[k];});
 ["vrWidth","vrHeight","vrPercent","vrAlpha"].forEach(id=>{if(v[id]!==undefined)$(id).value=String(v[id]);});}catch(_){}}
function savePrefs(){try{const v=Object.assign({},state);["vrWidth","vrHeight","vrPercent","vrAlpha"].forEach(id=>v[id]=$(id).value);localStorage.setItem(PREFS_KEY,JSON.stringify(v));}catch(_){}}

function n(v){if(typeof v==="number")return v;if(v&&typeof v.value==="number")return v.value;return Number(v);}
function box(layer){
 const b=layer.boundsNoEffects||layer.bounds;
 const out={l:n(b.left),t:n(b.top),r:n(b.right),b:n(b.bottom)};
 out.w=out.r-out.l;out.h=out.b-out.t;
 if(![out.l,out.t,out.w,out.h].every(Number.isFinite)||out.w<=0||out.h<=0)throw Error("图层没有可测量的范围："+layer.name);
 return out;
}
function setStatus(s,kind){$("vrStatus").textContent=s;$("vrStatus").className="vr-status"+(kind===true||kind==="error"?" error":kind==="ok"?" ok":"");}
function numeric(id,fallback){const v=parseFloat(String($(id).value).trim());return Number.isFinite(v)?v:fallback;}
function pathTo(doc,layer){
 const path=[];let current=layer;
 while(current&&current.id!==doc.id){
  const parent=current.parent;
  const siblings=Array.from(parent&&parent.id!==doc.id?parent.layers:doc.layers);
  const i=siblings.findIndex(x=>x.id===current.id);
  if(i<0)throw Error("无法定位图层："+layer.name);
  path.unshift(i);if(!parent||parent.id===doc.id)break;current=parent;
 }
 return path;
}
function layerAtPath(doc,path){
 let children=Array.from(doc.layers),target=null;
 for(const i of path){target=children[i];if(!target)return null;children=Array.from(target.layers||[]);}
 return target;
}
function getAll(doc){
 const out=[];const walk=arr=>{for(const l of Array.from(arr||[])){out.push(l);if(l.layers)walk(l.layers);}};walk(doc.layers);return out;
}
function isolate(doc,path,vis){
 for(const l of getAll(doc))if(vis.has(l.id))l.visible=vis.get(l.id);
 let children=Array.from(doc.layers);
 for(const i of path){
  const target=children[i];
  if(!target)throw Error("临时文档层级与源文档不同");
  for(const l of children)l.visible=l.id===target.id;
  children=Array.from(target.layers||[]);
 }
}
async function compositeAlpha(doc,layerId,region){
 // Full-composite read: Photoshop does not support layerID targeting a group.
 const width=n(doc.width),height=n(doc.height);
 const crop=region||{left:0,top:0,right:width,bottom:height};
 const cropW=crop.right-crop.left,cropH=crop.bottom-crop.top;
 // Full resolution up to MAX_READ px; only larger areas are read reduced (marked as approx).
 const ratio=Math.min(1,MAX_READ/Math.max(cropW,cropH));
 const opts={documentID:doc.id,componentSize:8,colorSpace:"RGB",applyAlpha:false,
   sourceBounds:crop};
 if(layerId!==null&&layerId!==undefined)opts.layerID=layerId;
 if(ratio<1)opts.targetSize={width:Math.max(1,Math.round(cropW*ratio)),height:Math.max(1,Math.round(cropH*ratio))};
 let image;
 try{
  const data=await imaging.getPixels(opts);image=data.imageData;
  if(!image||image.components!==4)throw Error("无法获得透明 Alpha 通道，请检查图层是否透明");
  const arr=await image.getData({chunky:true}),w=image.width,h=image.height,components=image.components;
  let left=w,top=h,right=-1,bottom=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   if(arr[(y*w+x)*components+3]>alphaThreshold){
    if(x<left)left=x;if(x>right)right=x;if(y<top)top=y;if(y>bottom)bottom=y;
   }
  }
  if(right<0)throw Error("当前对象没有可见像素");
  const level=Math.pow(2,Math.max(0,Number(data.level)||0));
  const b=data.sourceBounds;
  if(!b)throw Error("图像接口没有返回像素边界");
  const l=Number(b.left)*level,t=Number(b.top)*level;
  const sx=(Number(b.right)-Number(b.left))*level/w;
  const sy=(Number(b.bottom)-Number(b.top))*level/h;
  const result={l:l+left*sx,t:t+top*sy,r:l+(right+1)*sx,b:t+(bottom+1)*sy};
  result.w=result.r-result.l;result.h=result.b-result.t;
  result.approx=ratio<1||sx>1.001||sy>1.001;
  if(![result.l,result.t,result.w,result.h].every(Number.isFinite)||result.w<=0||result.h<=0)throw Error("可见范围计算失败");
  return result;
 }finally{if(image)image.dispose();}
}
function comparePath(a,b){for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;}
function topSelected(doc){
 const picked=Array.from(doc.activeLayers||[]);
 const ids=new Set(picked.map(l=>l.id));
 return picked.filter(l=>{
  let p=l.parent;
  while(p){if(ids.has(p.id))return false;if(p.id===doc.id)break;p=p.parent;}
  return true;
 });
}
function choose(){
 const doc=app.activeDocument;
 if(!doc)throw Error("请先打开 Photoshop 文档");
 const filtered=topSelected(doc);
 if(!filtered.length)throw Error("请选中一个或多个图层 / 图层组");
 const W=n(doc.width),H=n(doc.height);
 // Layer panel order: top first (same order shown in the list; "1 号对象" is the first).
 const entries=filtered.map(l=>{const raw=box(l);return {layer:l,id:l.id,name:l.name,path:pathTo(doc,l),raw,visible:null,
   off:raw.l<0||raw.t<0||raw.r>W||raw.b>H};}).sort((a,b)=>comparePath(a.path,b.path));
 return {doc,entries};
}

/* ---------- Plan ---------- */
function referenceEntry(){
 if(!selection.length||selection.some(x=>!x.visible))return null;
 if(state.ref==="first")return selection[0];
 const area=x=>x.visible.w*x.visible.h;
 return selection.reduce((a,b)=>state.ref==="max"?(area(b)>area(a)?b:a):(area(b)<area(a)?b:a));
}
function target(){
 if(state.basis==="ref"){const r=referenceEntry();if(!r)throw Error("请先读取对象");return {w:r.visible.w,h:r.visible.h,ref:r};}
 const w=numeric("vrWidth",NaN),h=numeric("vrHeight",NaN);
 if(!(w>=1&&h>=1&&w<=30000&&h<=30000))throw Error("尺寸范围：1 ~ 30000 px");
 return {w,h,ref:null};
}
// Returns scale factors and which dimension(s) the result is expected to hit exactly.
function planFor(x,t){
 if(!x.visible)throw Error("请先读取实际可见像素");
 if(state.basis==="percent"){
  const p=numeric("vrPercent",NaN);
  if(!(p>=0.1&&p<=10000))throw Error("百分比范围：0.1 ~ 10000 %");
  return {f:[p/100,p/100],ctrl:x.visible.w>=x.visible.h?"w":"h"};
 }
 const a=t.w/x.visible.w,b=t.h/x.visible.h,m=state.method;
 if(m==="contain")return a<=b?{f:[a,a],ctrl:"w"}:{f:[b,b],ctrl:"h"};
 if(m==="cover")return a>=b?{f:[a,a],ctrl:"w"}:{f:[b,b],ctrl:"h"};
 if(m==="width")return {f:[a,a],ctrl:"w"};
 if(m==="height")return {f:[b,b],ctrl:"h"};
 return {f:[a,b],ctrl:"both"};
}
function buildPlan(){
 const t=state.basis==="percent"?null:target();
 return selection.map(x=>{const p=planFor(x,t);return {entry:x,f:p.f,ctrl:p.ctrl,exp:{w:x.visible.w*p.f[0],h:x.visible.h*p.f[1]},isRef:!!(t&&t.ref===x)};});
}
const fmt=v=>{const r=Math.round(v*10)/10;return Math.abs(r-Math.round(r))<0.05?String(Math.round(r)):r.toFixed(1);};
const size=b=>fmt(b.w)+" × "+fmt(b.h);

/* ---------- UI ---------- */
function active(id,val){root.querySelectorAll("#"+id+" [data-value]").forEach(b=>{const on=b.getAttribute("data-value")===val;b.classList.toggle("active",on);b.setAttribute("aria-checked",on?"true":"false");});}
function syncActive(){
 active("vrBasis",state.basis);active("vrRef",state.ref);active("vrModes",state.method);active("vrModes2",state.method);
 active("vrAnchor",state.anchor);active("vrInterp",state.interp);active("vrResetScope",state.resetScope);
}
const MODE_DESC={contain:"等比例缩放，整个对象放进目标框里；宽或高其中一边等于目标值。",cover:"等比例缩放，宽和高都不小于目标值；另一边可能超出。",width:"按目标宽度等比例缩放，高度自动变化。",height:"按目标高度等比例缩放，宽度自动变化。",stretch:"宽、高分别缩放到目标值，对象可能变形。"};
const ANCHOR_DESC={"0,0":"左上角","0.5,0":"顶部中点","1,0":"右上角","0,0.5":"左侧中点","0.5,0.5":"中心","1,0.5":"右侧中点","0,1":"左下角","0.5,1":"底部中点","1,1":"右下角"};
function update(){
 $("vrSizeFields").style.display=state.basis==="size"?"flex":"none";
 $("vrRefFields").style.display=state.basis==="ref"?"block":"none";
 $("vrPercentFields").style.display=state.basis==="percent"?"flex":"none";
 $("vrModeSection").style.display=state.basis==="percent"?"none":"block";
 $("vrModeDesc").textContent=MODE_DESC[state.method]||"";
 $("vrAnchorNote").textContent="缩放后，每个对象可见内容的"+ANCHOR_DESC[state.anchor]+"留在原位置。"+(state.interp==="nearest"?" 邻近：边缘不平滑，适合像素风素材。":"");
 const r=state.basis==="ref"?referenceEntry():null;
 $("vrRefNote").textContent=r?"参考：「"+r.name+"」 "+size(r.visible)+" px":"读取后显示参考对象的尺寸。";
 renderList();
}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function renderList(){
 const list=$("vrList");list.innerHTML="";
 $("vrCount").textContent=selection.length?selection.length+" 个":"";
 $("vrFix").style.display="none";
 if(!selection.length){list.appendChild(el("div","vr-empty",documentId===null?"选中图层后自动读取":"没有可调整的对象"));$("vrStats").textContent="";return;}
 let plan=null,planError="";
 if(selection.every(x=>x.visible)){try{plan=buildPlan();}catch(e){planError=e.message;}}
 let ups=0,lo=Infinity,hi=-Infinity,flagged=0;
 const limit=Math.min(selection.length,80);
 for(let i=0;i<limit;i++){
  const x=selection[i],p=plan&&plan[i],c=check&&check.get(x.id);
  const item=el("div","vr-item"+(i===0?" vr-item-first":""));
  const line=el("div","vr-item-line");
  line.appendChild(el("span","vr-item-name",(i+1)+". "+x.name));
  if(p&&p.isRef)line.appendChild(el("span","vr-tag ref","参考"));
  const sub=el("div","vr-item-size");
  if(c&&x.visible){
   const ok=isOnTarget(x.visible,c);
   if(!ok)flagged++;
   line.appendChild(el("span","vr-tag "+(ok?"ok":"warn"),ok?"已对齐":"有偏差"));
   sub.textContent="实际 "+size(x.visible)+(ok?" px":" px · 目标 "+targetText(c));
  }else if(!x.visible){
   sub.textContent="未测量"+(x.error?"："+x.error:"");
  }else if(p){
   const pct=p.f[0]===p.f[1]?fmt(p.f[0]*100)+"%":fmt(p.f[0]*100)+"% / "+fmt(p.f[1]*100)+"%";
   const up=p.f[0]>1.0005||p.f[1]>1.0005;if(up)ups++;
   lo=Math.min(lo,p.f[0],p.f[1]);hi=Math.max(hi,p.f[0],p.f[1]);
   line.appendChild(el("span","vr-tag"+(up?" up":""),up?"放大 "+pct:pct));
   sub.textContent=size(x.visible)+" → "+size(p.exp)+" px"+(x.visible.approx?"（约）":"");
  }else sub.textContent=size(x.visible)+" px";
  item.appendChild(line);item.appendChild(sub);list.appendChild(item);
 }
 if(selection.length>limit)list.appendChild(el("div","vr-empty","另外 "+(selection.length-limit)+" 个对象未列出"));
 if(check){
  $("vrFix").style.display=flagged?"flex":"none";
  $("vrStats").textContent=flagged?flagged+" 个对象和目标差 1px 以上，可点「修正偏差」再微调一次。":"全部对象已达到目标尺寸。";
 }else if(plan){
  $("vrStats").textContent="缩放 "+fmt(lo*100)+"%"+(hi-lo>0.0005?" ~ "+fmt(hi*100)+"%":"")+(ups?" · "+ups+" 个会放大，可能变糊":"")+(selection.some(x=>x.visible.approx)?" · 「约」表示对象过大，按缩小图测量":"");
 }else $("vrStats").textContent=planError;
}
// After a resize, compare the measured size with the expected one on the dimension(s)
// the chosen method promises to hit (rounded to whole pixels).
function isOnTarget(v,c){
 if(v.approx)return true; // reduced-resolution reading cannot judge 1px
 const okW=Math.abs(v.w-Math.round(c.exp.w))<0.5,okH=Math.abs(v.h-Math.round(c.exp.h))<0.5;
 return c.ctrl==="both"?okW&&okH:c.ctrl==="w"?okW:okH;
}
function targetText(c){return c.ctrl==="both"?Math.round(c.exp.w)+" × "+Math.round(c.exp.h)+" px":c.ctrl==="w"?"宽 "+Math.round(c.exp.w)+" px":"高 "+Math.round(c.exp.h)+" px";}
function setBusy(on){working=on;["vrApply","vrRead","vrReset100","vrFix"].forEach(id=>$(id).classList.toggle("vr-busy",on));}
function showSource(entries){
 $("vrSource").textContent=entries.length?(entries.length===1?entries[0].name:entries.length+" 个对象 · "+entries.slice(0,2).map(x=>x.name).join("、")+(entries.length>2?"…":"")):"未选择图层";
}

/* ---------- Read ---------- */
async function read(){
 if(working)return;
 setBusy(true);
 try{
  const picked=choose();selection=picked.entries;documentId=picked.doc.id;showSource(selection);
  alphaThreshold=Math.max(0,Math.min(254,Math.round(numeric("vrAlpha",8))));
  setStatus("正在测量可见像素…");
  // Direct sampling is much faster for regular raster/smart/text layers. Groups,
  // objects reaching outside the canvas and layers Photoshop rejects use the slower
  // temporary composite copy.
  const needsComposite=[];
  await core.executeAsModal(async()=>{
   for(const entry of selection){
    if(entry.layer.layers||entry.off){needsComposite.push(entry);continue;}
    try{
     const doc=picked.doc,b=entry.raw;
     const crop={left:Math.max(0,Math.floor(b.l)),top:Math.max(0,Math.floor(b.t)),
       right:Math.min(n(doc.width),Math.ceil(b.r)),bottom:Math.min(n(doc.height),Math.ceil(b.b))};
     if(crop.right<=crop.left||crop.bottom<=crop.top)throw Error("图层超出画布");
     entry.visible=await compositeAlpha(doc,entry.id,crop);
    }catch(error){needsComposite.push(entry);}
   }
  },{commandName:"读取普通图层可见范围"});
  if(needsComposite.length){
   setStatus("正在测量 "+needsComposite.length+" 个图层组或超出画布的对象…");
   await core.executeAsModal(async()=>{
    let temp=null;
    try{
     temp=await picked.doc.duplicate("尺寸测量_临时副本",false);
     // Expand the temporary copy so parts outside the canvas are measured too.
     if(needsComposite.some(e=>e.off))await temp.revealAll();
     const originalVis=new Map(getAll(temp).map(l=>[l.id,l.visible]));
     for(let i=0;i<needsComposite.length;i++){
      const entry=needsComposite[i];
      try{
       const tl=layerAtPath(temp,entry.path);
       if(!tl)throw Error("临时文档层级与源文档不同");
       const tb=box(tl),dx=tb.l-entry.raw.l,dy=tb.t-entry.raw.t;
       isolate(temp,entry.path,originalVis);
       const region={left:Math.max(0,Math.floor(tb.l)),top:Math.max(0,Math.floor(tb.t)),
         right:Math.min(n(temp.width),Math.ceil(tb.r)),bottom:Math.min(n(temp.height),Math.ceil(tb.b))};
       if(region.right<=region.left||region.bottom<=region.top)throw Error("对象超出画布");
       const v=await compositeAlpha(temp,null,region);
       entry.visible={l:v.l-dx,t:v.t-dy,r:v.r-dx,b:v.b-dy,w:v.w,h:v.h,approx:v.approx};
      }catch(e){
       throw Error("「"+entry.name+"」测量失败："+(e.message||e));
      }
     }
    }finally{if(temp)await temp.close(constants.SaveOptions.DONOTSAVECHANGES);}
   },{commandName:"批量尺寸统一：复杂对象测量"});
  }
  const offs=selection.filter(x=>x.off).length;
  $("vrSourceMeta").textContent=selection.length===1?"可见 "+size(selection[0].visible)+" px":"已测量 "+selection.length+" 个对象的可见像素";
  setStatus("已读取"+(needsComposite.length?"（"+needsComposite.length+" 个用合成方式测量"+(offs?"，含 "+offs+" 个超出画布的对象":"")+"）":"")+"。","ok");
 }catch(e){selection=[];$("vrSourceMeta").textContent="在 Photoshop 中选中图层或组";showSource([]);setStatus(e.message||String(e),true);}
 finally{setBusy(false);update();}
}

/* ---------- Selection safety ---------- */
const TEMP_SELECTION_CHANNEL="__visible_resize_selection__";
// An active pixel selection would limit scale/translate to the selected pixels only.
async function stashSelection(doc){
 try{
  const r=await action.batchPlay([{_obj:"get",_target:[{_property:"selection"},{_ref:"document",_id:doc.id}]}],{});
  if(!(r&&r[0]&&r[0].selection))return false;
  await action.batchPlay([
   {_obj:"duplicate",_target:[{_ref:"channel",_property:"selection"}],name:TEMP_SELECTION_CHANNEL,_options:{dialogOptions:"dontDisplay"}},
   {_obj:"set",_target:[{_ref:"channel",_property:"selection"}],to:{_enum:"ordinal",_value:"none"},_options:{dialogOptions:"dontDisplay"}}
  ],{});
  return true;
 }catch(e){console.warn("[Batch Resize] could not stash selection",e);return false;}
}
async function restoreSelection(){
 try{
  await action.batchPlay([
   {_obj:"set",_target:[{_ref:"channel",_property:"selection"}],to:{_ref:"channel",_name:TEMP_SELECTION_CHANNEL},_options:{dialogOptions:"dontDisplay"}},
   {_obj:"delete",_target:[{_ref:"channel",_name:TEMP_SELECTION_CHANNEL}],_options:{dialogOptions:"dontDisplay"}}
  ],{});
 }catch(e){console.warn("[Batch Resize] could not restore selection",e);}
}
async function selectLayer(id,add){
 const d={_obj:"select",_target:[{_ref:"layer",_id:id}],makeVisible:false,_options:{dialogOptions:"dontDisplay"}};
 if(add)d.selectionModifier={_enum:"selectionModifierType",_value:"addToSelection"};
 const r=await action.batchPlay([d],{});
 if(r[0]&&r[0]._obj==="error")throw Error(r[0].message||"选择图层失败");
}
async function reselect(ids){for(let i=0;i<ids.length;i++){try{await selectLayer(ids[i],i>0);}catch(_){}}}

/* ---------- Resize ---------- */
function validateForChange(){
 const doc=app.activeDocument;if(!doc||doc.id!==documentId)throw Error("文档已变更，请重新读取");
 const ids=new Set(topSelected(doc).map(x=>x.id));
 for(const item of selection){
  if(!ids.has(item.id))throw Error("选中的图层发生变化，请重新读取");
  const raw=box(item.layer);
  if([raw.l,raw.t,raw.w,raw.h].some((v,i)=>Math.abs(v-[item.raw.l,item.raw.t,item.raw.w,item.raw.h][i])>0.5))throw Error("图层已移动或修改，请重新读取："+item.name);
  if(item.layer.isBackgroundLayer||item.layer.positionLocked||item.layer.allLocked)throw Error("含背景或锁定对象："+item.name);
 }
 return doc;
}
// Scales every op's layer and keeps the chosen anchor point of its visible content in place.
async function runScale(doc,ops,historyName){
 const [ax,ay]=state.anchor.split(",").map(Number);
 const interp=state.interp==="nearest"?{interpolation:constants.InterpolationMethod.NEARESTNEIGHBOR}:undefined;
 const ids=selection.map(x=>x.id);
 await core.executeAsModal(async ctx=>{
  const hist=await ctx.hostControl.suspendHistory({documentID:doc.id,name:historyName});
  let committed=false;
  try{
   const hadSelection=await stashSelection(doc);
   try{
    for(let i=0;i<ops.length;i++){
     const {entry,f}=ops[i];setStatus("正在调整 "+(i+1)+"/"+ops.length+"："+entry.name);
     try{
      await selectLayer(entry.id);
      if(interp)await entry.layer.scale(f[0]*100,f[1]*100,constants.AnchorPosition.MIDDLECENTER,interp);
      else await entry.layer.scale(f[0]*100,f[1]*100,constants.AnchorPosition.MIDDLECENTER);
      // Photoshop scales about the layer-bounds centre; move so the anchor point of the
      // visible content (e.g. its bottom centre) lands where it was before.
      const cx=(entry.raw.l+entry.raw.r)/2,cy=(entry.raw.t+entry.raw.b)/2;
      const px=entry.visible.l+entry.visible.w*ax,py=entry.visible.t+entry.visible.h*ay;
      const dx=px-(cx+(px-cx)*f[0]),dy=py-(cy+(py-cy)*f[1]);
      if(Math.abs(dx)>0.05||Math.abs(dy)>0.05)await entry.layer.translate(dx,dy);
     }catch(e){throw Error("「"+entry.name+"」调整失败："+(e.message||e));}
    }
   }finally{if(hadSelection)await restoreSelection();}
   await reselect(ids);
   committed=true;
  }finally{await ctx.hostControl.resumeHistory(hist,committed);}
 },{commandName:historyName});
}
async function apply(){
 if(working)return;
 if(!selection.length||selection.some(x=>!x.visible)){setStatus("请先成功读取所有对象的可见像素",true);return;}
 let ops,doc;
 try{
  doc=validateForChange();
  ops=buildPlan();
  for(const op of ops)if(op.f.some(v=>v<0.001||v>100))throw Error("比例超出安全范围（0.1% ~ 10000%），请调整目标");
 }catch(e){setStatus(e.message||String(e),true);return;}
 setBusy(true);
 try{
  await runScale(doc,ops.filter(o=>Math.abs(o.f[0]-1)>1e-6||Math.abs(o.f[1]-1)>1e-6),"批量尺寸统一");
  check=new Map(ops.map(o=>[o.id||o.entry.id,{exp:o.exp,ctrl:o.ctrl}]));
  ignoreSelectUntil=Date.now()+1000;
 }catch(e){setBusy(false);setStatus("执行失败，已自动还原："+(e.message||e),true);return;}
 setBusy(false);
 await read();
 if(selection.length)setStatus("已调整 "+ops.length+" 个对象，可用 Ctrl+Z 一次撤销。","ok");
}
// Second, small pass: bring flagged objects to the rounded target on their key dimension.
async function fixDeviation(){
 if(working||!check)return;
 let ops,doc;
 try{
  doc=validateForChange();
  ops=[];
  for(const x of selection){
   const c=check.get(x.id);if(!c||!x.visible||isOnTarget(x.visible,c))continue;
   const tw=Math.round(c.exp.w),th=Math.round(c.exp.h);
   let f;
   if(c.ctrl==="both")f=state.basis!=="percent"&&state.method==="stretch"?[tw/x.visible.w,th/x.visible.h]:[tw/x.visible.w,tw/x.visible.w];
   else if(c.ctrl==="w")f=[tw/x.visible.w,tw/x.visible.w];
   else f=[th/x.visible.h,th/x.visible.h];
   if(f.some(v=>!(v>0.5&&v<2)))throw Error("「"+x.name+"」偏差过大，请重新读取后再调整");
   ops.push({entry:x,f});
  }
  if(!ops.length){setStatus("没有需要修正的对象。","ok");return;}
 }catch(e){setStatus(e.message||String(e),true);return;}
 setBusy(true);
 try{await runScale(doc,ops,"批量尺寸统一：修正偏差");ignoreSelectUntil=Date.now()+1000;}
 catch(e){setBusy(false);setStatus("修正失败，已自动还原："+(e.message||e),true);return;}
 setBusy(false);
 await read();
 if(selection.length)setStatus("已修正 "+ops.length+" 个对象，可用 Ctrl+Z 撤销这次修正。","ok");
}

/* ---------- Smart object reset ---------- */
// Reset Transform is non-destructive only for Smart Objects.
// Ordinary pixel layers have no reliable original scale to recover.
function smartObjectsIn(doc,scope){
 const result=[],ids=new Set();
 const visit=layers=>{for(const layer of Array.from(layers||[])){
   if(layer.layers){visit(layer.layers);continue;}
   const kind=String(layer.kind||"").toLowerCase();
   if(kind.includes("smart")&&!ids.has(layer.id)){ids.add(layer.id);result.push(layer);}
 }};
 if(scope==="all"){visit(doc.layers);}
 else{
   for(const top of Array.from(doc.activeLayers||[])){
     if(top.layers)continue; // reset applies to individual layers only
     const kind=String(top.kind||"").toLowerCase();
     if(kind.includes("smart")&&!ids.has(top.id)){ids.add(top.id);result.push(top);}
   }
 }
 return result;
}
function disarmReset(){if(resetArmed){clearTimeout(resetArmed);resetArmed=null;}$("vrReset100").textContent="一键还原";}
async function resetSmartObjects(){
 if(working)return;
 let doc,layers;
 try{
   doc=app.activeDocument;
   if(!doc)throw Error("请先打开文档");
   layers=smartObjectsIn(doc,state.resetScope);
   if(!layers.length)throw Error("没有找到可还原的智能对象图层。普通像素层无法恢复原始 100%。");
   const locked=layers.find(x=>x.allLocked||x.positionLocked);
   if(locked)throw Error("请先解锁智能对象："+locked.name);
 }catch(e){disarmReset();setStatus(e.message||String(e),true);return;}
 // "文档全部" can touch many layers: require a second click within 5 seconds.
 if(state.resetScope==="all"&&!resetArmed){
   $("vrReset100").textContent="确认还原 "+layers.length+" 个";
   setStatus("将把文档里全部 "+layers.length+" 个智能对象还原为原始变换（含旋转、斜切）。5 秒内再点一次确认。");
   resetArmed=setTimeout(()=>{resetArmed=null;$("vrReset100").textContent="一键还原";setStatus("已取消还原。");},5000);
   return;
 }
 disarmReset();
 const ids=Array.from(doc.activeLayers||[]).map(l=>l.id);
 setBusy(true);
 try{
   await core.executeAsModal(async ctx=>{
     const hist=await ctx.hostControl.suspendHistory({documentID:doc.id,name:"批量还原智能对象 100%"});
     let committed=false;
     try{
       for(const layer of layers){
         await selectLayer(layer.id);
         const result=await action.batchPlay([{_obj:"placedLayerResetTransforms",_options:{dialogOptions:"dontDisplay"}}],{});
         if(result&&result[0]&&String(result[0]._obj).toLowerCase()==="error")
           throw Error("图层「"+layer.name+"」："+(result[0].message||"重置变换失败"));
       }
       await reselect(ids);
       committed=true;
     }finally{await ctx.hostControl.resumeHistory(hist,committed);}
   },{commandName:"智能对象恢复原始大小"});
   check=null;ignoreSelectUntil=Date.now()+1000;
 }catch(e){setBusy(false);setStatus("还原失败，已自动撤回："+(e.message||String(e)),true);return;}
 setBusy(false);
 if(ids.length)await read();
 setStatus("已将 "+layers.length+" 个智能对象还原为原始大小。普通图层和组未修改。","ok");
}

/* ---------- Events ---------- */
function onActivate(e,handler){
 e.addEventListener("click",handler);
 e.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();handler();}});
}
function settingsChanged(){check=null;update();savePrefs();}
[["vrBasis","basis"],["vrRef","ref"],["vrModes","method"],["vrModes2","method"],["vrAnchor","anchor"],["vrInterp","interp"],["vrResetScope","resetScope"]].forEach(pair=>{
 root.querySelectorAll("#"+pair[0]+" [data-value]").forEach(b=>onActivate(b,()=>{
  state[pair[1]]=b.getAttribute("data-value");syncActive();
  if(pair[0]==="vrResetScope"){disarmReset();savePrefs();return;}
  settingsChanged();
 }));
});
["vrWidth","vrHeight","vrPercent"].forEach(id=>{
 $(id).addEventListener("input",()=>{check=null;update();});
 $(id).addEventListener("change",settingsChanged);
});
$("vrAlpha").addEventListener("change",()=>{savePrefs();if(!working&&selection.length){check=null;read();}});
onActivate($("vrRead"),()=>{if(!working)read();});
onActivate($("vrApply"),apply);
onActivate($("vrFix"),fixDeviation);
onActivate($("vrReset100"),resetSmartObjects);

// Auto read when the layer selection changes. Plain layers are measured right away;
// groups or objects outside the canvas need a temporary copy, so only a hint is shown.
function autoRead(force){
 const doc=app.activeDocument;
 if(!doc){selection=[];documentId=null;showSource([]);update();return;}
 let picked=[];try{picked=topSelected(doc);}catch(_){}
 if(!picked.length){selection=[];documentId=null;check=null;showSource([]);$("vrSourceMeta").textContent="在 Photoshop 中选中图层或组";setStatus("选中图层后会自动读取。");update();return;}
 const same=documentId===doc.id&&picked.length===selection.length&&picked.every(l=>selection.some(x=>x.id===l.id));
 if(same&&!force)return;
 const W=n(doc.width),H=n(doc.height);
 const slow=picked.some(l=>{if(l.layers)return true;try{const b=box(l);return b.l<0||b.t<0||b.r>W||b.b>H;}catch(_){return false;}});
 check=null;
 if(slow){
  selection=[];documentId=null;
  showSource(picked.map(l=>({name:l.name})));
  $("vrSourceMeta").textContent="含图层组或超出画布的对象";
  setStatus("选择已变化，点「重新读取」测量（需要复制文档，稍慢）。");update();return;
 }
 read();
}
let autoTimer=null;
try{
 action.addNotificationListener(["select","open","close","make","delete"],()=>{
  if(root.style.display==="none"||working||Date.now()<ignoreSelectUntil)return;
  if(autoTimer!==null)clearTimeout(autoTimer);
  autoTimer=setTimeout(()=>{autoTimer=null;if(!working&&root.style.display!=="none")autoRead();},300);
 });
}catch(e){console.warn("[Batch Resize] selection listener unavailable",e);}
root.__visibleResizeActivate=function(){if(!working)autoRead(true);};
loadPrefs();syncActive();update();
setTimeout(()=>{if(!working&&root.style.display!=="none")autoRead();},0);
};

/* Batch Visible Resize - Photoshop UXP. Completely isolated from Smart Arrange. */
module.exports=function initVisibleResize(root){
"use strict";
const ps=require("photoshop"),app=ps.app,core=ps.core,imaging=ps.imaging,constants=ps.constants;
const $=id=>root.querySelector("#"+id);
let selection=[],documentId=null,working=false,method="contain",preserveCenter=true,alphaThreshold=8;
function n(v){if(typeof v==="number")return v;if(v&&typeof v.value==="number")return v.value;return Number(v);}
function box(layer){
 const b=layer.boundsNoEffects||layer.bounds;
 const out={l:n(b.left),t:n(b.top),r:n(b.right),b:n(b.bottom)};
 out.w=out.r-out.l;out.h=out.b-out.t;
 if(![out.l,out.t,out.w,out.h].every(Number.isFinite)||out.w<=0||out.h<=0)throw Error("图层没有可测量的范围："+layer.name);
 return out;
}
function setStatus(s,error){$("vrStatus").textContent=s;$("vrStatus").className="vr-status"+(error?" error":"");}
function numeric(id,fallback){const v=Number($(id).value);return Number.isFinite(v)?v:fallback;}
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
 const max=768,ratio=Math.min(1,max/Math.max(cropW,cropH));
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
  if(![result.l,result.t,result.w,result.h].every(Number.isFinite)||result.w<=0||result.h<=0)throw Error("可见范围计算失败");
  return result;
 }finally{if(image)image.dispose();}
}
function choose(){
 const doc=app.activeDocument;
 if(!doc)throw Error("请先打开 Photoshop 文档");
 const picked=Array.from(doc.activeLayers||[]);
 if(!picked.length)throw Error("请选中一个或多个图层 / 图层组");
 const ids=new Set(picked.map(l=>l.id));
 const filtered=picked.filter(l=>{
  let p=l.parent;
  while(p){if(ids.has(p.id))return false;if(p.id===doc.id)break;p=p.parent;}
  return true;
 });
 return {doc,entries:filtered.map(l=>({layer:l,id:l.id,name:l.name,path:pathTo(doc,l),raw:box(l),visible:null}))};
}
function syncInfo(){
 $("vrSource").textContent=selection.length?(selection.length+" 个对象 · "+selection.map(x=>x.name).slice(0,2).join("、")+(selection.length>2?"…":"")):"尚未读取对象";
 $("vrCount").textContent=selection.length?selection.length+" 个对象":"";
 const table=$("vrResults");table.innerHTML="";
 for(let i=0;i<Math.min(selection.length,12);i++){
  const x=selection[i],r=document.createElement("div");
  r.className="vr-result";
  const name=document.createElement("span");name.className="vr-name";name.textContent=x.name;
  const size=document.createElement("span");size.className="vr-size";size.textContent=x.visible?Math.round(x.visible.w)+" × "+Math.round(x.visible.h)+" px":"未测量";
  r.appendChild(name);r.appendChild(size);table.appendChild(r);
 }
 if(selection.length>12){const more=document.createElement("div");more.className="vr-extra";more.textContent="另外 "+(selection.length-12)+" 个对象";table.appendChild(more);}
}
function scaleFactors(x){
 const w=numeric("vrWidth",256),h=numeric("vrHeight",256);
 if(w<1||h<1||w>30000||h>30000)throw Error("尺寸范围：1 ~ 30000 px");
 if(!x.visible)throw Error("请先读取实际可见像素");
 const a=w/x.visible.w,b=h/x.visible.h;
 if(method==="contain")return [Math.min(a,b),Math.min(a,b)];
 if(method==="cover")return [Math.max(a,b),Math.max(a,b)];
 if(method==="width")return [a,a];
 if(method==="height")return [b,b];
 return [a,b];
}
function describe(){
 try{
  const preview=$("vrStats");if(!selection.length){preview.textContent="读取图层后显示目标比例";return;}
  const examples=selection.map(scaleFactors);
  const lo=Math.min(...examples.map(x=>x[0]*100)),hi=Math.max(...examples.map(x=>x[0]*100));
  preview.textContent="缩放："+Math.round(lo)+"%"+(Math.abs(hi-lo)>0.1?" ~ "+Math.round(hi)+"%":"")+" · "+selection.length+" 个独立对象";
 }catch(e){$("vrStats").textContent=e.message;}
}
async function read(){
 if(working)return;
 working=true;$("vrRead").disabled=true;$("vrApply").disabled=true;
 try{
  const picked=choose();selection=picked.entries;documentId=picked.doc.id;syncInfo();
  setStatus("正在分析最终可见像素；测量时只会修改临时文档。");
  alphaThreshold=Math.max(0,Math.min(254,numeric("vrAlpha",8)));
  // Direct sampling is much faster for regular raster/smart/text layers.
  // Only layers that Photoshop rejects (including full layer groups) need
  // the much slower temporary composite workflow.
  const needsComposite=[];
  await core.executeAsModal(async()=>{
   for(let i=0;i<selection.length;i++){
    const entry=selection[i];
    if(entry.layer.layers){needsComposite.push(entry);continue;}
    try{
     const doc=picked.doc,b=entry.raw;
     const crop={left:Math.max(0,Math.floor(b.l)),top:Math.max(0,Math.floor(b.t)),
       right:Math.min(n(doc.width),Math.ceil(b.r)),bottom:Math.min(n(doc.height),Math.ceil(b.b))};
     if(crop.right<=crop.left||crop.bottom<=crop.top)throw Error("图层超出画布");
     entry.visible=await compositeAlpha(doc,entry.id,crop);
    }catch(error){
     needsComposite.push(entry);
    }
   }
  },{commandName:"读取普通图层可见范围"});
  if(needsComposite.length){
   setStatus("正在测量 "+needsComposite.length+" 个复杂图层组…");
   await core.executeAsModal(async()=>{
    let temp=null;
    try{
     temp=await picked.doc.duplicate("尺寸测量_临时副本",false);
     const originalVis=new Map(getAll(temp).map(l=>[l.id,l.visible]));
     for(let i=0;i<needsComposite.length;i++){
      const entry=needsComposite[i];
      try{
       isolate(temp,entry.path,originalVis);
       const vb=entry.raw;
       const region={left:Math.max(0,Math.floor(vb.l)),top:Math.max(0,Math.floor(vb.t)),
         right:Math.min(n(temp.width),Math.ceil(vb.r)),bottom:Math.min(n(temp.height),Math.ceil(vb.b))};
       if(region.right<=region.left||region.bottom<=region.top)throw Error("对象超出画布");
       entry.visible=await compositeAlpha(temp,null,region);
      }catch(e){
       throw Error("第 "+(i+1)+" 个复杂对象「"+entry.name+"」测量失败："+(e.message||e));
      }
     }
    }finally{if(temp)await temp.close(constants.SaveOptions.DONOTSAVECHANGES);}
   },{commandName:"批量尺寸统一：复杂对象测量"});
  }
  syncInfo();describe();setStatus("已读取 "+selection.length+" 个对象的实际可见像素"+(needsComposite.length?"（其中 "+needsComposite.length+" 个复杂对象采用合成测量）":"（快速模式）")+"。");
 }catch(e){selection=[];documentId=null;syncInfo();setStatus(e.message||String(e),true);}
 finally{working=false;$("vrRead").disabled=false;$("vrApply").disabled=false;}
}
async function selectLayer(id){
 const r=await ps.action.batchPlay([{_obj:"select",_target:[{_ref:"layer",_id:id}],makeVisible:false,_options:{dialogOptions:"dontDisplay"}}],{});
 if(r[0]&&r[0]._obj==="error")throw Error(r[0].message||"选择图层失败");
}
async function apply(){
 if(working)return;
 if(!selection.length||selection.some(x=>!x.visible)){setStatus("请先成功读取所有对象的可见像素",true);return;}
 let ops,doc;
 try{
  doc=app.activeDocument;if(!doc||doc.id!==documentId)throw Error("文档已变更，请重新读取");
  const ids=new Set(Array.from(doc.activeLayers||[]).map(x=>x.id));
  for(const item of selection){
   if(!ids.has(item.id))throw Error("选中的图层发生变化，请重新读取");
   const raw=box(item.layer);
   if([raw.l,raw.t,raw.w,raw.h].some((v,i)=>Math.abs(v-[item.raw.l,item.raw.t,item.raw.w,item.raw.h][i])>0.5))throw Error("图层已移动或修改，请重新读取："+item.name);
   if(item.layer.isBackgroundLayer||item.layer.positionLocked||item.layer.allLocked)throw Error("含背景或锁定对象："+item.name);
  }
  ops=selection.map(x=>({entry:x,factors:scaleFactors(x)}));
  for(const op of ops)if(op.factors.some(v=>v<0.001||v>100))throw Error("比例超出安全范围（0.1% ~ 10000%），请调整目标尺寸");
 }catch(e){setStatus(e.message||String(e),true);return;}
 working=true;$("vrRead").disabled=true;$("vrApply").disabled=true;
 try{
  await core.executeAsModal(async ctx=>{
   const hist=await ctx.hostControl.suspendHistory({documentID:documentId,name:"批量尺寸统一"});
   try{
    for(let i=0;i<ops.length;i++){
     const {entry,factors}=ops[i];setStatus("正在调整 "+(i+1)+"/"+ops.length+"："+entry.name);
     try{
      await selectLayer(entry.id);
      await entry.layer.scale(factors[0]*100,factors[1]*100,constants.AnchorPosition.MIDDLECENTER);
      if(preserveCenter){
       // Center of rendered visible pixels, not center of oversized clipping bounds.
       const originalRawCenterX=(entry.raw.l+entry.raw.r)/2;
       const originalRawCenterY=(entry.raw.t+entry.raw.b)/2;
       const visCX=(entry.visible.l+entry.visible.r)/2,visCY=(entry.visible.t+entry.visible.b)/2;
       const predictedX=originalRawCenterX+(visCX-originalRawCenterX)*factors[0];
       const predictedY=originalRawCenterY+(visCY-originalRawCenterY)*factors[1];
       const dx=visCX-predictedX,dy=visCY-predictedY;
       if(Math.abs(dx)>0.05||Math.abs(dy)>0.05){await selectLayer(entry.id);await entry.layer.translate(dx,dy);}
      }
     }catch(e){throw Error("第 "+(i+1)+" 个对象「"+entry.name+"」调整失败："+(e.message||e));}
    }
   }finally{await ctx.hostControl.resumeHistory(hist);}
  },{commandName:"批量尺寸统一"});
  setStatus("已完成 "+ops.length+" 个对象。可用 Ctrl+Z 撤销整个操作。");
  selection=[];syncInfo();describe();
 }catch(e){setStatus("执行失败："+(e.message||e)+"；若已修改部分对象，请 Ctrl+Z 撤销。",true);}
 finally{working=false;$("vrRead").disabled=false;$("vrApply").disabled=false;}
}
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
async function resetSmartObjects(){
 if(working)return;
 let doc,layers;
 try{
   doc=app.activeDocument;
   if(!doc)throw Error("请先打开文档");
   layers=smartObjectsIn(doc,$("vrResetScope").value);
   if(!layers.length)throw Error("没有找到可还原的智能对象图层。普通像素层无法恢复原始 100%。");
   const locked=layers.find(x=>x.allLocked||x.positionLocked);
   if(locked)throw Error("请先解锁智能对象："+locked.name);
 }catch(e){setStatus(e.message||String(e),true);return;}
 working=true;$("vrReset100").disabled=true;$("vrRead").disabled=true;$("vrApply").disabled=true;
 let completed=0;
 try{
   await core.executeAsModal(async ctx=>{
     const hist=await ctx.hostControl.suspendHistory({documentID:doc.id,name:"批量还原智能对象 100%"});
     try{
       for(const layer of layers){
         await selectLayer(layer.id);
         const result=await ps.action.batchPlay([{
           _obj:"placedLayerResetTransforms",_options:{dialogOptions:"dontDisplay"}
         }],{});
         if(result&&result[0]&&String(result[0]._obj).toLowerCase()==="error")
           throw Error("图层「"+layer.name+"」："+(result[0].message||"重置变换失败"));
         completed++;
       }
     }finally{await ctx.hostControl.resumeHistory(hist);}
   },{commandName:"智能对象恢复原始大小"});
   selection=[];documentId=null;syncInfo();describe();
   setStatus("已将 "+completed+" 个智能对象恢复到原始变换状态。普通图层和组未修改。");
 }catch(e){setStatus("还原中断："+(e.message||String(e))+"；已处理 "+completed+" 个，可 Ctrl+Z 撤销。",true);}
 finally{working=false;$("vrReset100").disabled=false;$("vrRead").disabled=false;$("vrApply").disabled=false;}
}
$("vrReset100").addEventListener("click",resetSmartObjects);
$("vrListToggle").addEventListener("click",()=>{
 const area=$("vrResultDetails"),open=area.style.display!=="none";
 area.style.display=open?"none":"block";
 $("vrListToggle").textContent=open?"展开详情 ▾":"收起详情 ▴";
});
root.querySelectorAll("#vrModes button").forEach(b=>b.addEventListener("click",()=>{
 method=b.dataset.mode;root.querySelectorAll("#vrModes button").forEach(x=>x.classList.toggle("active",x===b));
 const descriptions={contain:"等比例缩放，完整保留图片；宽高不一定都达到目标值。",cover:"等比例缩放，使宽和高都覆盖目标尺寸；可能超过目标范围。",width:"按目标宽度等比例调整，高度自动变化。",height:"按目标高度等比例调整，宽度自动变化。",stretch:"宽高分别缩放到指定尺寸，可能使图片变形。"};
 $("vrModeDesc").textContent=descriptions[method]||"";describe();
}));
["vrWidth","vrHeight"].forEach(id=>$(id).addEventListener("input",describe));
$("vrRead").addEventListener("click",read);
$("vrApply").addEventListener("click",apply);
$("vrCenter").addEventListener("change",()=>{preserveCenter=$("vrCenter").checked;});
$("vrAlpha").addEventListener("input",()=>{setStatus("Alpha 阈值已调整，请点击读取重新测量。");});
root.__visibleResizeActivate=function(){if(!working&&selection.length===0){$("vrSource").textContent="选择图层或组后点击读取";}};
syncInfo();describe();
};
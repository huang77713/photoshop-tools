/* Smart Arrange - Photoshop UXP */
module.exports = function(root) {
  "use strict";
  const photoshop=require("photoshop"),app=photoshop.app,core=photoshop.core,imaging=photoshop.imaging;
  const $=id=>root.querySelector("#"+id);
  const state={op:"copy",layout:"grid",flow:"row",corner:"tl",layers:[],docId:null,busy:false,measure:"visible",alpha:12,spacingMode:"uniform"};
  const count=(id,min,max,d)=>{const n=Number($(id).value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):d;};
  function unit(v){return typeof v==="number"?v:(v&&typeof v.value==="number"?v.value:(v&&typeof v._value==="number"?v._value:Number(v)));}
  function bounds(layer){
    const b=layer.boundsNoEffects||layer.bounds;
    const x={l:unit(b.left),t:unit(b.top),r:unit(b.right),b:unit(b.bottom)};
    x.w=x.r-x.l;x.h=x.b-x.t;
    if(Object.values(x).some(v=>!Number.isFinite(v))||x.w<=0||x.h<=0)throw Error("对象没有有效可见边界："+layer.name);
    return x;
  }
  /* Read rendered group pixels, including clipping masks and masks.
     This does NOT merge, rasterize or change source layers. */
  async function visibleBounds(layer,raw,docId,threshold,composite) {
    const maxSide=1200;
    const target=Math.min(1,maxSide/Math.max(raw.w,raw.h));
    const opts={documentID:docId,componentSize:8,colorSpace:"RGB",applyAlpha:false,
      sourceBounds:{left:Math.floor(raw.l),top:Math.floor(raw.t),right:Math.ceil(raw.r),bottom:Math.ceil(raw.b)}};
    if(!composite)opts.layerID=layer.id;
    if(target<1) opts.targetSize={width:Math.max(1,Math.round(raw.w*target)),height:Math.max(1,Math.round(raw.h*target))};
    let image;
    try {
      const response=await imaging.getPixels(opts);
      image=response.imageData;
      if(!image || image.components!==4)throw Error("没有得到 RGBA 合成像素（components="+(image&&image.components)+"）");
      const values=await image.getData({chunky:true});
      const W=image.width,H=image.height,C=image.components;
      let minX=W,minY=H,maxX=-1,maxY=-1;
      const cutoff=threshold;
      for(let y=0;y<H;y++){
        for(let x=0;x<W;x++){
          if(values[(y*W+x)*C+C-1]>cutoff){
            if(x<minX)minX=x;if(x>maxX)maxX=x;
            if(y<minY)minY=y;if(y>maxY)maxY=y;
          }
        }
      }
      if(maxX<0)throw Error("对象合成后没有可见像素");
      // Adobe returns sourceBounds in cache-pyramid coordinates. Convert to document
      // coordinates before mapping alpha pixels; never assume requested bounds survived trim.
      const box=response.sourceBounds||opts.sourceBounds;
      const levelScale=Math.pow(2,Math.max(0,Number(response.level)||0));
      const left=Number(box.left)*levelScale,top=Number(box.top)*levelScale;
      const spanW=(Number(box.right)-Number(box.left))*levelScale;
      const spanH=(Number(box.bottom)-Number(box.top))*levelScale;
      const measured={l:left+minX*spanW/W,t:top+minY*spanH/H,
        r:left+(maxX+1)*spanW/W,b:top+(maxY+1)*spanH/H};
      measured.w=measured.r-measured.l; measured.h=measured.b-measured.t;
      return measured;
    }finally{if(image)image.dispose();}
  }
  // Photoshop imaging.getPixels(layerID) does not support group layers.
  // Instead duplicate only the requested group into a transparent scratch document,
  // measure its document composite and delete it. The source PSD is untouched.
  async function measureLayer(item,sourceDoc,workDoc) {
    if(state.measure!=="visible"){item.b=item.raw;item.fallback=false;item.reason="";return;}
    let clone=null;
    try{
      if(!item.layer.layers){
        try {
          item.b=await visibleBounds(item.layer,item.raw,sourceDoc.id,state.alpha,false);
          item.fallback=false;item.reason="";return;
        }catch(err){ /* masks, fills and smart objects may require composite mode */ }
      }
      if(!workDoc)throw Error("无法创建临时合成文档");
      const copies=await sourceDoc.duplicateLayers([item.layer],workDoc);
      clone=copies&&copies[0];
      if(!clone)throw Error("无法复制图层到临时文档");
      // Keep internal clipping masks and effects intact. The duplicate document
      // contains only this group, so composite alpha reflects actually visible pixels.
      const cloneRaw=bounds(clone);
      const sampled=await visibleBounds(clone,cloneRaw,workDoc.id,state.alpha,true);
      const shiftX=item.raw.l-cloneRaw.l,shiftY=item.raw.t-cloneRaw.t;
      item.b={l:sampled.l+shiftX,t:sampled.t+shiftY,r:sampled.r+shiftX,b:sampled.b+shiftY,w:sampled.w,h:sampled.h};
      item.fallback=false;item.reason="";
    }catch(error){
      item.b=item.raw;item.fallback=true;item.reason=String(error&&error.message||error);
      console.warn("[Smart Arrange] composite measurement failed for",item.name,error);
    }finally{
      if(clone)try{await clone.delete();}catch(error){console.error("[Smart Arrange] scratch cleanup failed:",error);}
    }
  }
  function status(str,err){$("saStatus").textContent=str;$("saStatus").className="sa-status"+(err?" error":"");}
  function active(id,val){root.querySelectorAll("#"+id+" button").forEach(b=>b.classList.toggle("active",b.dataset.value===val));}
  function update(){
    const grid=state.layout==="grid",copy=state.op==="copy";
    $("saQuantity").style.display=copy&&!grid?"flex":"none";
    $("saGridFields").style.display=grid?"flex":"none";
    $("saAutoWrap").style.display=grid&&!copy?"flex":"none";
    $("saFlowWrap").style.display=grid?"block":"none";
    $("saRows").disabled=!copy&&$("saAuto").checked;
    $("saGapX").disabled=state.layout==="vertical";
    $("saGapY").disabled=state.layout==="horizontal";
    $("saSpacingNote").textContent=state.spacingMode==="uniform"?"用所有对象的最大宽高建立统一单元格，图层在单元格内居中。":"按每行和每列实际尺寸安排，图层左上对齐。";
    $("saHint").textContent=copy?"一个图层或组：原对象 + 复制对象。":"至少两个对象：移动原图层，不生成副本。";
    $("saRun").textContent=copy?"生成复制排列":"整理选中对象";
  }
  async function read(){
    const doc=app.activeDocument;
    if(!doc)throw Error("请先打开 Photoshop 文档。");
    const picked=Array.from(doc.activeLayers||[]);
    if(!picked.length)throw Error("请在 PS 图层面板选中图层或组。");
    const entries=picked.map(layer=>({layer,id:layer.id,name:layer.name,raw:bounds(layer),b:bounds(layer)}));
    entries.forEach(e=>{let parent=e.layer.parent;while(parent){if(entries.some(x=>x.id===parent.id))throw Error("不能同时排列父组及组内子图层。");parent=parent.parent;}});
    state.layers=entries;state.docId=doc.id;
    if(state.measure==="visible") {
      await core.executeAsModal(async(ctx)=>{
        let scratch=null;
        try{
          // Create once for the whole selection, not once per group.
          scratch=await app.createDocument({
            name:"智能排列-临时可见范围",width:Math.round(doc.width),height:Math.round(doc.height),
            resolution:Number(doc.resolution)||72,mode:"RGBColorMode",fill:"transparent"
          });
          if(!scratch)throw Error("临时文档创建失败");
          await ctx.hostControl.registerAutoCloseDocument(scratch.id);
          for(const item of entries)await measureLayer(item,doc,scratch);
        }finally{
          if(scratch)await scratch.close(photoshop.constants.SaveOptions.DONOTSAVECHANGES);
        }
      },{commandName:"读取可见像素（临时合成）"});
    } else {
      for(const item of entries)await measureLayer(item,doc,null);
    }
    $("saSelected").textContent=entries.length===1?entries[0].name:entries.length+" 个对象已选中";
    $("saDetail").textContent=entries.length===1?Math.round(entries[0].b.w)+" × "+Math.round(entries[0].b.h)+" px · "+(entries[0].layer.layers?"图层组":"图层"):entries.slice(0,3).map(e=>e.name).join("、")+(entries.length>3?"…":"");
    if(entries.length>1){state.op="organize";$("saAuto").checked=true;active("saOp","organize");}
    else {state.op="copy";active("saOp","copy");}
    update();preview();status(entries.some(e=>e.fallback)?"部分对象无法读取可见像素，回退到原始边界："+entries.filter(e=>e.fallback).map(e=>e.name+"（"+e.reason+"）").slice(0,2).join("、"):"已按"+(state.measure==="visible"?"可见像素":"图层边界")+"读取，可以开始排列。",entries.some(e=>e.fallback));
  }
  function getPlan(){
    if(!state.layers.length)throw Error("请先读取选中图层。");
    const isCopy=state.op==="copy";
    if(isCopy&&state.layers.length!==1)throw Error("复制排列必须只选中一个对象。");
    if(!isCopy&&state.layers.length<2)throw Error("整理排列需要至少两个对象。");
    const auto=$("saAuto").checked;
    
    const total=isCopy?(state.layout==="grid"?count("saRows",1,120,2)*count("saCols",1,120,3):count("saCount",1,120,6)):state.layers.length;
    if(total>120)throw Error("单次最多处理 120 个对象。");
    const cols=state.layout==="vertical"?1:state.layout==="horizontal"?total:count("saCols",1,120,3);
    const rows=state.layout==="horizontal"?1:state.layout==="vertical"?total:(!isCopy&&auto?Math.ceil(total/cols):count("saRows",1,120,2));
    if(rows*cols<total)throw Error("排列位置不足，请增加行列数或启用自动行数。");
    const gx=count("saGapX",0,10000,20),gy=count("saGapY",0,10000,20);
    const sorted=state.layers.slice().sort((a,b)=>a.b.t-b.b.t||a.b.l-b.b.l);
    const list=isCopy?Array.from({length:total},()=>sorted[0]):sorted;
    const colWidth=Array(cols).fill(0),rowHeight=Array(rows).fill(0);
    const maxW=Math.max(...list.map(x=>x.b.w)),maxH=Math.max(...list.map(x=>x.b.h));
    const cells=list.map((item,i)=>{
      let r,c;
      if(state.layout==="horizontal"){r=0;c=i;}
      else if(state.layout==="vertical"){r=i;c=0;}
      else if(state.flow==="column"){r=i%rows;c=Math.floor(i/rows);}
      else {r=Math.floor(i/cols);c=i%cols;}
      colWidth[c]=Math.max(colWidth[c],item.b.w);rowHeight[r]=Math.max(rowHeight[r],item.b.h);
      return {item,i,r,c};
    });
    if(state.spacingMode==="uniform"){colWidth.fill(maxW);rowHeight.fill(maxH);}
    const X=[0],Y=[0];
    for(let k=1;k<cols;k++)X[k]=X[k-1]+colWidth[k-1]+gx;
    for(let k=1;k<rows;k++)Y[k]=Y[k-1]+rowHeight[k-1]+gy;
    const width=X[cols-1]+colWidth[cols-1],height=Y[rows-1]+rowHeight[rows-1];
    const l=Math.min(...sorted.map(o=>o.b.l)),t=Math.min(...sorted.map(o=>o.b.t));
    const right=Math.max(...sorted.map(o=>o.b.r)),bottom=Math.max(...sorted.map(o=>o.b.b));
    const originX=state.corner.endsWith("r")?right-width:l,originY=state.corner.startsWith("b")?bottom-height:t;
    const placements=cells.map(cell=>{
      const c=state.corner.endsWith("r")?cols-1-cell.c:cell.c;
      const r=state.corner.startsWith("b")?rows-1-cell.r:cell.r;
      const innerX=state.spacingMode==="uniform"?(colWidth[c]-cell.item.b.w)/2:0;
      const innerY=state.spacingMode==="uniform"?(rowHeight[r]-cell.item.b.h)/2:0;
      return {...cell,x:originX+X[c]+innerX,y:originY+Y[r]+innerY};
    });
    return {placements,width,height,gx,gy};
  }
  function preview(){
    const surface=$("saPreview");surface.innerHTML="";
    try{
      const p=getPlan();
      // Always fit the complete grid into the small preview stage, with safe margins.
      const panelW=Math.max(100,Math.min(300,surface.clientWidth-22||280));
      const panelH=88;
      const scale=Math.min(panelW/Math.max(1,p.width),panelH/Math.max(1,p.height),1.5);
      const stage=document.createElement("div");stage.className="sa-stage";
      stage.style.width=Math.max(1,p.width*scale)+"px";
      stage.style.height=Math.max(1,p.height*scale)+"px";

      const rawLeft=Math.min(...p.placements.map(o=>o.x));
      const rawTop=Math.min(...p.placements.map(o=>o.y));
      // Keep bounding cells consistent for uniform mode; minX/minY are from the bounding
      // rectangle, not arbitrary first tile.
      p.placements.forEach((o,i)=>{
        const el=document.createElement("div");el.className="sa-tile"+(i===0?" first":"");
        el.style.left=Math.max(0,(o.x-rawLeft)*scale)+"px";
        el.style.top=Math.max(0,(o.y-rawTop)*scale)+"px";
        el.style.width=Math.max(1,o.item.b.w*scale)+"px";
        el.style.height=Math.max(1,o.item.b.h*scale)+"px";
        const label=document.createElement("span");label.textContent=String(i+1);
        if(o.item.b.w*scale>=15&&o.item.b.h*scale>=15)el.appendChild(label);
        el.title=String(i+1)+" · "+o.item.name;
        stage.appendChild(el);
      });
      surface.appendChild(stage);
      $("saCountLabel").textContent=p.placements.length+" 个对象";
      $("saPreviewNote").textContent="整体 "+Math.round(p.width)+" × "+Math.round(p.height)+" px · 间距 "+p.gx+" / "+p.gy+" px";
    }catch(e){
      const el=document.createElement("div");el.className="sa-empty";el.textContent=e.message;surface.appendChild(el);
      $("saCountLabel").textContent="待调整";
    }
  }
  async function generate(){
    if(state.busy)return;
    let plan,doc;
    try{
      plan=getPlan();doc=app.activeDocument;
      if(state.measure==="visible"&&state.layers.some(x=>x.fallback))throw Error("有对象无法测量可见像素，请先修复读取失败或在更多设置选择图层边界。");
      if(!doc||doc.id!==state.docId)throw Error("文档已切换，请重新读取。");
      const now=Array.from(doc.activeLayers||[]).map(l=>l.id).sort().join(",");
      const old=state.layers.map(o=>o.id).sort().join(",");
      if(now!==old)throw Error("图层选择发生变化，请重新读取。");
      for(const item of state.layers){const b=bounds(item.layer);if(Math.abs(b.l-item.raw.l)>0.5||Math.abs(b.t-item.raw.t)>0.5||Math.abs(b.w-item.raw.w)>0.5||Math.abs(b.h-item.raw.h)>0.5)throw Error("对象位置或尺寸已变化，请重新读取。");}
      if(state.layers.some(o=>o.layer.positionLocked||o.layer.allLocked||o.layer.isBackgroundLayer))throw Error("含锁定图层或背景图层，不能排列。");
    }catch(e){status(e.message,true);return;}
    state.busy=true;$("saRun").disabled=true;status("正在处理 "+plan.placements.length+" 个对象…");
    try{
      await core.executeAsModal(async ctx=>{
        const token=await ctx.hostControl.suspendHistory({documentID:state.docId,name:"智能排列"});
        try{
          const original=state.layers[0].layer;
          for(let i=0;i<plan.placements.length;i++){
            const p=plan.placements[i];
            const target=state.op==="copy"?(i===0?original:await original.duplicate()):p.item.layer;
            const b=bounds(target);
            const dx=p.x-(b.l+(p.item.b.l-p.item.raw.l)),dy=p.y-(b.t+(p.item.b.t-p.item.raw.t));
            if(Math.abs(dx)>0.01||Math.abs(dy)>0.01)await target.translate(dx,dy);
          }
        }finally{await ctx.hostControl.resumeHistory(token);}
      },{commandName:"智能排列"});
      status("完成！共 "+plan.placements.length+" 个对象，可用 Ctrl+Z 撤销。");
    }catch(e){status("操作失败："+(e.message||e)+"；若有部分修改，可 Ctrl+Z 撤销。",true);}
    finally{state.busy=false;$("saRun").disabled=false;}
  }
  [["saOp","op"],["saLayout","layout"],["saFlow","flow"],["saCorner","corner"]].forEach(pair=>{
    root.querySelectorAll("#"+pair[0]+" button").forEach(b=>b.addEventListener("click",()=>{
      state[pair[1]]=b.dataset.value;active(pair[0],b.dataset.value);update();preview();
    }));
  });
  ["saCount","saRows","saCols","saGapX","saGapY","saAuto"].forEach(id=>{
    $(id).addEventListener("input",()=>{update();preview();});
    $(id).addEventListener("change",()=>{update();preview();});
  });
  $("saRead").addEventListener("click",async()=>{try{await read();}catch(e){status(e.message,true);}});
  $("saRun").addEventListener("click",generate);
  $("saAdvancedToggle").addEventListener("click",()=>{const panel=$("saAdvancedPanel");const open=panel.style.display!=="none";panel.style.display=open?"none":"block";$("saAdvancedToggle").setAttribute("aria-expanded",String(!open));$("saAdvanceArrow").textContent=open?"▾":"▴";});
  root.querySelectorAll("#saSpacingMode button").forEach(b=>b.addEventListener("click",()=>{state.spacingMode=b.dataset.value;active("saSpacingMode",state.spacingMode);update();preview();}));
  root.querySelectorAll("#saMeasure button").forEach(b=>b.addEventListener("click",async()=>{state.measure=b.dataset.value;active("saMeasure",state.measure);try{await read();}catch(e){status(e.message,true);}}));
  $("saReset").addEventListener("click",()=>{
    state.layout="grid";state.flow="row";state.corner="tl";state.spacingMode="uniform";active("saSpacingMode","uniform");
    [["saCount",6],["saRows",2],["saCols",3],["saGapX",20],["saGapY",20]].forEach(p=>$(p[0]).value=p[1]);
    $("saAuto").checked=false;
    active("saLayout","grid");active("saFlow","row");active("saCorner","tl");update();preview();
  });
  root.__smartArrangeActivate=async()=>{try{await read();}catch(e){status(e.message,true);preview();}};
  update();root.__smartArrangeActivate();
};
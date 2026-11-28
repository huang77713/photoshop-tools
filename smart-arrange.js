/* Smart Arrange - Photoshop UXP
   v3: measuring, copying (group / nested group duplication), layer order and moving
   are unchanged. Added: div-based controls, spacing basis (object #1 / largest object /
   equal gaps), cell alignment, optional numbered copy names, optional grouping,
   auto read on selection change, remembered settings. */
module.exports = function(root) {
  "use strict";
  const photoshop=require("photoshop"),app=photoshop.app,core=photoshop.core,imaging=photoshop.imaging;
  const $=id=>root.querySelector("#"+id);
  const state={op:"copy",layout:"grid",flow:"row",corner:"tl",layers:[],docId:null,busy:false,measure:"visible",forceVisible:false,forceBounds:false,alpha:12,spacingMode:"uniform",
    basis:"anchor",alignX:"center",alignY:"middle",autoRows:false,nameCopies:true,groupAfter:false};
  const PREFS_KEY="smartArrange.v3.prefs";
  const PREF_FIELDS=["layout","flow","corner","basis","alignX","alignY","autoRows","nameCopies","groupAfter"];
  function loadPrefs(){try{const v=JSON.parse(localStorage.getItem(PREFS_KEY)||"{}");PREF_FIELDS.forEach(k=>{if(v[k]!==undefined)state[k]=v[k];});
    ["saCount","saRows","saCols","saGapX","saGapY"].forEach(id=>{if(v[id]!==undefined)$(id).value=String(v[id]);});}catch(_){}}
  function savePrefs(){try{const v={};PREF_FIELDS.forEach(k=>v[k]=state[k]);["saCount","saRows","saCols","saGapX","saGapY"].forEach(id=>v[id]=$(id).value);localStorage.setItem(PREFS_KEY,JSON.stringify(v));}catch(_){}}
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
    const sourceDoc=Array.from(app.documents||[]).find(d=>d.id===docId);
    if(!sourceDoc)throw Error("合成文档不存在");
    const crop={left:Math.max(0,Math.floor(raw.l)),top:Math.max(0,Math.floor(raw.t)),right:Math.min(Math.ceil(sourceDoc.width),Math.ceil(raw.r)),bottom:Math.min(Math.ceil(sourceDoc.height),Math.ceil(raw.b))};
    if(crop.right<=crop.left||crop.bottom<=crop.top)throw Error("对象超出临时文档画布");
    const opts={documentID:docId,componentSize:8,colorSpace:"RGB",applyAlpha:false,sourceBounds:crop};
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
  // A scratch COPY of the ENTIRE document is the only document mutated during
  // measurement. NEVER duplicate/delete/ungroup individual source layers.
  // Original group hierarchy remains untouched even on failure.
  function pathToLayer(sourceDoc,layer) {
    const path=[];let node=layer;
    // Document.parent is not a layer. Stop as soon as root document is reached.
    while(node && node.id!==sourceDoc.id){
      const parent=node.parent;
      const list=Array.from(parent&&parent.id!==sourceDoc.id?parent.layers:sourceDoc.layers);
      const at=list.findIndex(x=>x.id===node.id);
      if(at<0)throw Error("无法定位图层层级："+layer.name);
      path.unshift(at);
      if(!parent || parent.id===sourceDoc.id)break;
      node=parent;
    }
    return path;
  }
  function allLayersIn(doc){
    const all=[];
    const visit=arr=>{for(const layer of Array.from(arr||[])){all.push(layer);if(layer.layers)visit(layer.layers);}};
    visit(doc.layers);return all;
  }
  function isolateInCopy(copyDoc,path,visibility) {
    // Restore ALL original layer visibilities before measuring the next target.
    const all=allLayersIn(copyDoc);
    for(const layer of all)if(visibility.has(layer.id))layer.visible=visibility.get(layer.id);
    let container=Array.from(copyDoc.layers);
    for(let depth=0;depth<path.length;depth++){
      const target=container[path[depth]];
      if(!target)throw Error("副本文档图层路径无效");
      for(const layer of container)layer.visible=(layer.id===target.id);
      container=Array.from(target.layers||[]);
    }
  }
  async function measureFromDocumentCopy(item,copyDoc,visibility) {
    try{
      isolateInCopy(copyDoc,item.path,visibility);
      const canvas={l:0,t:0,r:Number(copyDoc.width),b:Number(copyDoc.height),
        w:Number(copyDoc.width),h:Number(copyDoc.height)};
      item.b=await visibleBounds(null,canvas,copyDoc.id,state.alpha,true);
      item.fallback=false;item.reason="";
    }catch(error){
      item.b=item.raw;item.fallback=true;item.reason=String(error&&error.message||error);
    }
  }
  function status(str,err){$("saStatus").textContent=str;$("saStatus").className="sa-status"+(err?" error":"");}
  function active(id,val){root.querySelectorAll("#"+id+" [data-value]").forEach(b=>{const on=b.getAttribute("data-value")===val;b.classList.toggle("active",on);b.setAttribute("aria-checked",on?"true":"false");});}
  function setCheck(id,on){$(id).setAttribute("aria-checked",on?"true":"false");}
  function update(){
    const grid=state.layout==="grid",copy=state.op==="copy";
    $("saQuantity").style.display=copy&&!grid?"flex":"none";
    $("saGridFields").style.display=grid?"flex":"none";
    $("saAutoWrap").style.display=grid&&!copy?"flex":"none";
    $("saFlowWrap").style.display=grid?"flex":"none";
    $("saNameRow").style.display=copy?"flex":"none";
    setCheck("saAutoWrap",state.autoRows);setCheck("saNameRow",state.nameCopies);setCheck("saGroupRow",state.groupAfter);
    $("saRows").disabled=!copy&&state.autoRows;
    $("saGapX").disabled=state.layout==="vertical";
    $("saGapY").disabled=state.layout==="horizontal";
    $("saSpacingNote").textContent=state.basis==="max"?"每格按选中对象里最大的宽高，对象之间不会重叠。"
      :state.basis==="gap"?"每个对象按自身大小排，相邻对象之间的空隙都等于设定的间距。"
      :"以 1 号对象尺寸作为每一格，其他对象按对齐方式放在格内，可能重叠。";
    $("saHint").textContent=copy?"一个图层或组：原对象 + 复制对象。":"至少两个对象：移动原图层，不生成副本。";
    $("saRun").textContent=copy?"生成复制排列":"整理选中对象";
  }
  async function read(){
    const doc=app.activeDocument;
    if(!doc)throw Error("请先打开 Photoshop 文档。");
    const picked=Array.from(doc.activeLayers||[]);
    if(!picked.length)throw Error("请在 PS 图层面板选中图层或组。");
    const ids=new Set(picked.map(x=>x.id));
    // Photoshop can return both a selected group and its children. When the
    // parent is selected the children are implicitly included in its movement.
    // Filter them rather than blocking a legitimate group selection.
    const filtered=picked.filter(layer=>{
      let p=layer.parent;
      while(p){
        if(ids.has(p.id))return false;
        if(p.id===doc.id)break;
        p=p.parent;
      }
      return true;
    });
    if(!filtered.length)throw Error("当前选择没有独立的可排列对象。");
    const entries=filtered.map(layer=>({layer,id:layer.id,name:layer.name,path:pathToLayer(doc,layer),raw:bounds(layer),b:bounds(layer)}));
    state.layers=entries;state.docId=doc.id;
    state.ignoredChildren=picked.length-filtered.length;
    // Organizing many existing objects must be instantaneous by default.
    // Save the expensive pixel-composite scan for a single complex group,
    // or for a user explicitly enabling it in Advanced settings.
    // Fast by default for both one and many selected objects. Exact alpha
    // scanning is explicitly opt-in, and never runs from normal panel activation.
    state.measure=state.forceVisible?"visible":"bounds";
    active("saMeasure",state.measure);
    if(state.measure==="visible") {
      // Duplicating the whole PSD preserves nested clipping masks and groups.
      // There are NO write operations on the source PSD in the read path.
      await core.executeAsModal(async()=>{
        let copy=null;
        try{
          copy=await doc.duplicate("智能排列_临时测量",false);
          const originalVisibility=new Map(allLayersIn(copy).map(layer=>[layer.id,layer.visible]));
          for(const item of entries)await measureFromDocumentCopy(item,copy,originalVisibility);
        }finally{
          if(copy)await copy.close(photoshop.constants.SaveOptions.DONOTSAVECHANGES);
        }
      },{commandName:"智能排列：只读测量"});
    } else {
      for(const item of entries){item.b=item.raw;item.fallback=false;item.reason="";}
    }
    $("saSelected").textContent=entries.length===1?entries[0].name:entries.length+" 个对象已选中";
    $("saDetail").textContent=entries.length===1?Math.round(entries[0].b.w)+" × "+Math.round(entries[0].b.h)+" px · "+(entries[0].layer.layers?"图层组":"图层"):entries.slice(0,3).map(e=>e.name).join("、")+(entries.length>3?"…":"");
    if(entries.length>1){state.op="organize";active("saOp","organize");}
    else {state.op="copy";active("saOp","copy");}
    update();preview();status(entries.some(e=>e.fallback)?"部分对象无法读取可见像素，回退到原始边界："+entries.filter(e=>e.fallback).map(e=>e.name+"（"+e.reason+"）").slice(0,2).join("、"):"已读取 "+entries.length+" 个独立对象"+(state.ignoredChildren?"（自动排除 "+state.ignoredChildren+" 个已包含的子图层）":"")+"，边界："+(state.measure==="visible"?"可见像素":"快速图层边界")+"。",entries.some(e=>e.fallback));
  }
  function getPlan(){
    if(!state.layers.length)throw Error("请先读取选中图层。");
    const isCopy=state.op==="copy";
    if(isCopy&&state.layers.length!==1)throw Error("复制排列必须只选中一个对象。");
    if(!isCopy&&state.layers.length<2)throw Error("整理排列需要至少两个对象。");
    const auto=state.autoRows;
    
    const total=isCopy?(state.layout==="grid"?count("saRows",1,120,2)*count("saCols",1,120,3):count("saCount",1,120,6)):state.layers.length;
    if(total>120)throw Error("单次最多处理 120 个对象。");
    const cols=state.layout==="vertical"?1:state.layout==="horizontal"?total:count("saCols",1,120,3);
    const rows=state.layout==="horizontal"?1:state.layout==="vertical"?total:(!isCopy&&auto?Math.ceil(total/cols):count("saRows",1,120,2));
    if(rows*cols<total)throw Error("排列位置不足，请增加行列数或启用自动行数。");
    const gx=count("saGapX",0,10000,20),gy=count("saGapY",0,10000,20);
    // Stable Photoshop Layers-panel order. Image size and oversized mask
    // bounds must NOT determine which object becomes #1 or #N.
    const sorted=state.layers.slice().sort((a,b)=>{
      const pa=a.path||[],pb=b.path||[];
      for(let k=0;k<Math.min(pa.length,pb.length);k++){
        if(pa[k]!==pb[k])return pa[k]-pb[k];
      }
      return pa.length-pb.length;
    });
    const list=isCopy?Array.from({length:total},()=>sorted[0]):sorted;
    // Grid position of each object (unchanged rules), then sizes by the spacing basis:
    //   anchor: every cell = object #1 (original behaviour, overlap allowed)
    //   max:    every cell = largest selected object (no overlap)
    //   gap:    objects keep their own size; neighbours are exactly gx / gy apart
    // Positions are built from the top-left, mirrored for other start corners, then
    // shifted so object #1 stays where it is (as before).
    const anchor=list[0];
    const rc=list.map((item,i)=>{
      let row,col;
      if(state.layout==="horizontal"){row=0;col=i;}
      else if(state.layout==="vertical"){row=i;col=0;}
      else if(state.flow==="column"){row=i%rows;col=Math.floor(i/rows);}
      else {row=Math.floor(i/cols);col=i%cols;}
      return {item,i,r:row,c:col,x:0,y:0};
    });
    // Mirroring for right / bottom start corners also mirrors in-cell alignment, so
    // flip it here first; the final result keeps the alignment the user chose.
    let ax=state.alignX==="left"?0:state.alignX==="right"?1:0.5;
    let ay=state.alignY==="top"?0:state.alignY==="bottom"?1:0.5;
    if(state.corner.endsWith("r"))ax=1-ax;
    if(state.corner.startsWith("b"))ay=1-ay;
    const nCols=Math.max(...rc.map(o=>o.c))+1,nRows=Math.max(...rc.map(o=>o.r))+1;
    let W,H,cellW,cellH;
    if(state.basis==="gap"){
      const byRow=!(state.layout==="vertical"||(state.layout==="grid"&&state.flow==="column"));
      if(byRow){
        const rowH=Array(nRows).fill(0),cursor=Array(nRows).fill(0);
        rc.forEach(o=>{rowH[o.r]=Math.max(rowH[o.r],o.item.b.h);});
        const rowY=[];let y=0;for(let r=0;r<nRows;r++){rowY.push(y);y+=rowH[r]+gy;}
        rc.slice().sort((a,b)=>a.r-b.r||a.c-b.c).forEach(o=>{o.x=cursor[o.r];cursor[o.r]+=o.item.b.w+gx;o.y=rowY[o.r]+(rowH[o.r]-o.item.b.h)*ay;});
        W=Math.max(...cursor)-gx;H=y-gy;
      }else{
        const colW=Array(nCols).fill(0),cursor=Array(nCols).fill(0);
        rc.forEach(o=>{colW[o.c]=Math.max(colW[o.c],o.item.b.w);});
        const colX=[];let x=0;for(let c=0;c<nCols;c++){colX.push(x);x+=colW[c]+gx;}
        rc.slice().sort((a,b)=>a.c-b.c||a.r-b.r).forEach(o=>{o.y=cursor[o.c];cursor[o.c]+=o.item.b.h+gy;o.x=colX[o.c]+(colW[o.c]-o.item.b.w)*ax;});
        W=x-gx;H=Math.max(...cursor)-gy;
      }
      cellW=0;cellH=0;
    }else{
      cellW=state.basis==="max"?Math.max(...list.map(o=>o.b.w)):anchor.b.w;
      cellH=state.basis==="max"?Math.max(...list.map(o=>o.b.h)):anchor.b.h;
      rc.forEach(o=>{o.x=o.c*(cellW+gx)+(cellW-o.item.b.w)*ax;o.y=o.r*(cellH+gy)+(cellH-o.item.b.h)*ay;});
      W=nCols*cellW+(nCols-1)*gx;H=nRows*cellH+(nRows-1)*gy;
    }
    if(state.corner.endsWith("r"))rc.forEach(o=>{o.x=W-o.x-o.item.b.w;});
    if(state.corner.startsWith("b"))rc.forEach(o=>{o.y=H-o.y-o.item.b.h;});
    const offX=anchor.b.l-rc[0].x,offY=anchor.b.t-rc[0].y;
    rc.forEach(o=>{o.x+=offX;o.y+=offY;});
    return {placements:rc,width:W,height:H,gx,gy,anchor:anchor.name,cellW,cellH};
  }
  function preview(){
    const surface=$("saPreview");surface.innerHTML="";
    try{
      const p=getPlan();
      // Always fit the complete grid into the small preview stage, with safe margins.
      const panelW=Math.max(100,(surface.clientWidth||300)-24);
      const panelH=Math.max(60,(surface.clientHeight||140)-24);
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
      $("saPreviewNote").textContent=(p.cellW?"每格 "+Math.round(p.cellW)+" × "+Math.round(p.cellH)+" px · ":"对象间等距 · ")+"间距 "+p.gx+" / "+p.gy+" px · 总范围 "+Math.round(p.width)+" × "+Math.round(p.height)+" px";
    }catch(e){
      const el=document.createElement("div");el.className="sa-empty";el.textContent=e.message;surface.appendChild(el);
      $("saCountLabel").textContent="待调整";
    }
  }
  async function selectExactly(id,docId) {
    const response=await photoshop.action.batchPlay([{
      _obj:"select",_target:[{_ref:"layer",_id:id}],
      makeVisible:false,_options:{dialogOptions:"silent"}
    }],{});
    if(response[0]&&String(response[0]._obj).toLowerCase()==="error")
      throw Error(response[0].message||"选中目标图层失败");
  }
  async function selectOriginal(ids,docId){
    for(let i=0;i<ids.length;i++){
      const cmd={_obj:"select",_target:[{_ref:"layer",_id:ids[i]}],
        makeVisible:false,_options:{dialogOptions:"silent"}};
      if(i>0)cmd.selectionModifier={_enum:"selectionModifierType",_value:"addToSelection"};
      const r=await photoshop.action.batchPlay([cmd],{});
      if(r[0]&&String(r[0]._obj).toLowerCase()==="error")throw Error(r[0].message);
    }
  }
  async function translateById(layer,docId,dx,dy){
    // Crucial for nested layers: select the actual group by unique ID first.
    // A _obj:"move" ... to:{_obj:"offset"} command is NOT equivalent to
    // Layer.translate and fails on nested groups with Invalid target for move.
    await selectExactly(layer.id,docId);
    await layer.translate(dx,dy);
  }
  async function duplicateKeepingParent(original,docId,index) {
    const parent=original.parent;
    const nested=!!(parent&&parent.id!==docId);
    const siblings=()=>Array.from(nested?parent.layers:app.activeDocument.layers);
    const before=new Set(siblings().map(l=>l.id));
    try{
      if(nested){
        // Duplicate by immutable layer ID, without a destination move.
        // PLACEINSIDE was incorrectly used previously and can trigger
        // "Invalid target for move" for an already nested group.
        const result=await photoshop.action.batchPlay([{
          _obj:"duplicate",
          _target:[{_ref:"layer",_id:original.id}],
          version:5,_options:{dialogOptions:"dontDisplay"}
        }],{});
        if(result&&result[0]&&String(result[0]._obj).toLowerCase()==="error")
          throw Error(result[0].message||"Photoshop 拒绝复制嵌套组");
      }else{
        const copy=await original.duplicate();
        if(!copy||copy.id===original.id)throw Error("Photoshop 未返回有效副本");
        return copy;
      }
      const after=siblings();
      const fresh=after.filter(l=>!before.has(l.id));
      if(fresh.length!==1)throw Error("复制后未能在原父组识别唯一新副本（新增 "+fresh.length+" 个）");
      const copy=fresh[0];
      if(copy.parent&&copy.parent.id!==parent.id)
        throw Error("新副本未保留原父组");
      return copy;
    }catch(error){
      throw Error("复制第 "+(index+1)+" 个对象「"+original.name+"」失败："+(error.message||error));
    }
  }
  async function generate(){
    if(state.busy)return;
    let plan,doc;
    try{
      plan=getPlan();doc=app.activeDocument;
      if(state.measure==="visible"&&state.layers.some(x=>x.fallback))throw Error("有对象无法测量可见像素，请先修复读取失败或在更多设置选择图层边界。");
      if(!doc||doc.id!==state.docId)throw Error("文档已切换，请重新读取。");
      const all=Array.from(doc.activeLayers||[]);
      const allIds=new Set(all.map(l=>l.id));
      const now=all.filter(layer=>{let p=layer.parent;while(p){if(allIds.has(p.id))return false;if(p.id===doc.id)break;p=p.parent;}return true;}).map(l=>l.id).sort().join(",");
      const old=state.layers.map(o=>o.id).sort().join(",");
      if(now!==old)throw Error("图层选择发生变化，请重新读取。");
      for(const item of state.layers){const b=bounds(item.layer);if(Math.abs(b.l-item.raw.l)>0.5||Math.abs(b.t-item.raw.t)>0.5||Math.abs(b.w-item.raw.w)>0.5||Math.abs(b.h-item.raw.h)>0.5)throw Error("对象位置或尺寸已变化，请重新读取。");}
      if(state.layers.some(o=>o.layer.positionLocked||o.layer.allLocked||o.layer.isBackgroundLayer))throw Error("含锁定图层或背景图层，不能排列。");
    }catch(e){status(e.message,true);return;}
    state.busy=true;$("saRun").classList.add("sa-busy");status("正在处理 "+plan.placements.length+" 个对象…");
    let groupNote="";
    try{
      await core.executeAsModal(async ctx=>{
        const token=await ctx.hostControl.suspendHistory({documentID:state.docId,name:"智能排列"});
        try{
          const original=state.layers[0].layer;
          const members=[];
          for(let i=0;i<plan.placements.length;i++){
            const p=plan.placements[i];
            const target=state.op==="copy"
              ?(i===0?original:await duplicateKeepingParent(original,state.docId,i))
              :p.item.layer;
            if(state.op==="copy"&&i>0&&state.nameCopies){try{target.name=original.name+"_"+String(i+1).padStart(2,"0");}catch(_){}}
            members.push(target);
            const b=bounds(target);
            const dx=p.x-(b.l+(p.item.b.l-p.item.raw.l)),dy=p.y-(b.t+(p.item.b.t-p.item.raw.t));
            if(Math.abs(dx)>0.01||Math.abs(dy)>0.01){
              try{
                await translateById(target,state.docId,dx,dy);
                // Never report success if Photoshop moved another selection or
                // silently ignored a group translation.
                const after=bounds(target);
                const errorX=Math.abs((after.l-b.l)-dx);
                const errorY=Math.abs((after.t-b.t)-dy);
                if(errorX>1.5||errorY>1.5){
                  throw Error("实际移动偏差："+Math.round(errorX)+"px / "+Math.round(errorY)+"px");
                }
              }catch(error){
                throw Error("无法移动第 "+(i+1)+" 个对象「"+p.item.name+"」（图层ID "+target.id+"）："+(error.message||error));
              }
            }
          }
          // Optional: put the arranged objects into one group, in place. Skip when they
          // already are exactly the whole content of one group.
          if(state.groupAfter&&members.length>1){
            const parentIds=new Set(members.map(l=>l.parent?l.parent.id:doc.id));
            const parent=members[0].parent;
            const alreadyGrouped=parentIds.size===1&&parent&&parent.id!==doc.id&&parent.layers&&parent.layers.length===members.length;
            if(alreadyGrouped)groupNote="已经在同一个组里，没有再新建组。";
            else{
              const g=await doc.createLayerGroup({name:state.op==="copy"?original.name+"_排列":"智能排列",fromLayers:members});
              groupNote="已放进组「"+g.name+"」。";
            }
          }
        }finally{
          try{await selectOriginal(state.layers.map(x=>x.id),state.docId);}
          catch(error){console.warn("[Smart Arrange] selection restore:",error);}
          await ctx.hostControl.resumeHistory(token);
        }
      },{commandName:"智能排列"});
      status("完成！共 "+plan.placements.length+" 个对象，可用 Ctrl+Z 撤销。"+(groupNote?" "+groupNote:""));$("saStatus").className="sa-status ok";
    }catch(e){status("操作失败："+(e.message||e)+"；若有部分修改，可 Ctrl+Z 撤销。",true);}
    finally{state.busy=false;$("saRun").classList.remove("sa-busy");}
  }
  function onActivate(el,handler){
    el.addEventListener("click",handler);
    el.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();handler();}});
  }
  [["saOp","op"],["saLayout","layout"],["saFlow","flow"],["saCorner","corner"],["saBasis","basis"],["saAlignX","alignX"],["saAlignY","alignY"]].forEach(pair=>{
    root.querySelectorAll("#"+pair[0]+" [data-value]").forEach(b=>onActivate(b,()=>{
      state[pair[1]]=b.getAttribute("data-value");active(pair[0],state[pair[1]]);update();preview();savePrefs();
    }));
  });
  [["saAutoWrap","autoRows"],["saNameRow","nameCopies"],["saGroupRow","groupAfter"]].forEach(pair=>onActivate($(pair[0]),()=>{
    state[pair[1]]=!state[pair[1]];update();preview();savePrefs();
  }));
  ["saCount","saRows","saCols","saGapX","saGapY"].forEach(id=>{
    $(id).addEventListener("input",()=>{update();preview();});
    $(id).addEventListener("change",()=>{update();preview();savePrefs();});
  });
  onActivate($("saRead"),async()=>{if(state.busy)return;try{await read();}catch(e){status(e.message,true);}});
  onActivate($("saRun"),generate);
  root.querySelectorAll("#saMeasure [data-value]").forEach(b=>onActivate(b,async()=>{if(state.busy)return;state.measure=b.getAttribute("data-value");state.forceVisible=state.measure==="visible";state.forceBounds=state.measure==="bounds";active("saMeasure",state.measure);try{await read();}catch(e){status(e.message,true);}}));
  onActivate($("saReset"),()=>{
    state.layout="grid";state.flow="row";state.corner="tl";state.spacingMode="uniform";state.forceVisible=false;state.forceBounds=false;
    state.basis="anchor";state.alignX="center";state.alignY="middle";state.autoRows=false;state.nameCopies=true;state.groupAfter=false;
    [["saCount",6],["saRows",2],["saCols",3],["saGapX",20],["saGapY",20]].forEach(p=>$(p[0]).value=p[1]);
    syncActive();update();preview();savePrefs();
  });
  function syncActive(){
    active("saOp",state.op);active("saLayout",state.layout);active("saFlow",state.flow);active("saCorner",state.corner);
    active("saBasis",state.basis);active("saAlignX",state.alignX);active("saAlignY",state.alignY);active("saMeasure",state.measure);
  }
  // Auto read on selection change. Fast bounds are cheap; the pixel scan duplicates the
  // whole PSD, so in that mode only a hint is shown and "重新读取" does the scan.
  let autoTimer=null;
  try{
    photoshop.action.addNotificationListener(["select","open","close"],()=>{
      if(root.style.display==="none"||state.busy)return;
      if(autoTimer!==null)clearTimeout(autoTimer);
      autoTimer=setTimeout(async()=>{
        autoTimer=null;
        if(state.forceVisible){status("选择已变化，点「重新读取」测量可见像素。");return;}
        try{await read();}catch(e){status(e.message,true);preview();}
      },250);
    });
  }catch(e){console.warn("[Smart Arrange] selection listener unavailable",e);}
  root.__smartArrangeActivate=async()=>{try{await read();}catch(e){status(e.message,true);preview();}};
  loadPrefs();syncActive();update();root.__smartArrangeActivate();
};
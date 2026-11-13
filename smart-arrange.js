/* Smart Arrange - Photoshop UXP */
module.exports = function(root) {
  "use strict";
  const photoshop=require("photoshop"),app=photoshop.app,core=photoshop.core,imaging=photoshop.imaging;
  const $=id=>root.querySelector("#"+id);
  const state={op:"copy",layout:"grid",flow:"row",corner:"tl",layers:[],docId:null,busy:false,measure:"visible",forceVisible:false,forceBounds:false,alpha:12,spacingMode:"uniform"};
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
    $("saSpacingNote").textContent="固定以 1 号对象尺寸建立单元格，其他对象在每格内居中，允许重叠。";
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
    // Organizing many existing objects must be instantaneous by default.
    // Save the expensive pixel-composite scan for a single complex group,
    // or for a user explicitly enabling it in Advanced settings.
    if(entries.length>1 && !state.forceVisible){
      state.measure="bounds";active("saMeasure","bounds");
    }else if(entries.length===1 && !state.forceBounds){
      state.measure="visible";active("saMeasure","visible");
    }
    if(state.measure==="visible") {
      for(const item of entries)item.path=pathToLayer(doc,item.layer);
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
    if(entries.length>1){state.op="organize";$("saAuto").checked=true;active("saOp","organize");}
    else {state.op="copy";active("saOp","copy");}
    update();preview();status(entries.some(e=>e.fallback)?"部分对象无法读取可见像素，回退到原始边界："+entries.filter(e=>e.fallback).map(e=>e.name+"（"+e.reason+"）").slice(0,2).join("、"):"已按"+(state.measure==="visible"?"可见像素":"图层边界（快速）")+"读取，可以开始排列。",entries.some(e=>e.fallback));
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
    const sorted=state.layers.slice().sort((a,b)=>(a.b.t+a.b.h/2)-(b.b.t+b.b.h/2)|| (a.b.l+a.b.w/2)-(b.b.l+b.b.w/2));
    const list=isCopy?Array.from({length:total},()=>sorted[0]):sorted;
    // Anchor-only layout: object #1 is the single fixed-size template.
    // Every other layer is centered on that virtual cell. Differences in
    // actual sizes never affect spacing, and overlapping is intentional.
    const anchor=list[0];
    const cellW=anchor.b.w,cellH=anchor.b.h;
    const stepX=cellW+gx,stepY=cellH+gy;
    const left=anchor.b.l,top=anchor.b.t;
    const cells=list.map((item,i)=>{
      let row,col;
      if(state.layout==="horizontal"){row=0;col=i;}
      else if(state.layout==="vertical"){row=i;col=0;}
      else if(state.flow==="column"){row=i%rows;col=Math.floor(i/rows);}
      else {row=Math.floor(i/cols);col=i%cols;}
      const visualCol=state.corner.endsWith("r")?-col:col;
      const visualRow=state.corner.startsWith("b")?-row:row;
      const x=left+visualCol*stepX+(cellW-item.b.w)/2;
      const y=top+visualRow*stepY+(cellH-item.b.h)/2;
      return {item,i,r:row,c:col,x,y};
    });
    return {placements:cells,width:cols*cellW+(cols-1)*gx,height:rows*cellH+(rows-1)*gy,
      gx,gy,anchor:anchor.name,cellW,cellH};
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
      $("saPreviewNote").textContent="基准 "+Math.round(p.cellW)+" × "+Math.round(p.cellH)+" px · 间距 "+p.gx+" / "+p.gy+" px";
    }catch(e){
      const el=document.createElement("div");el.className="sa-empty";el.textContent=e.message;surface.appendChild(el);
      $("saCountLabel").textContent="待调整";
    }
  }
  async function selectExactly(id,docId) {
    const response=await photoshop.action.batchPlay([{
      _obj:"select",_target:[{_ref:"layer",_id:id},{_ref:"document",_id:docId}],
      makeVisible:false,_options:{dialogOptions:"silent"}
    }],{});
    if(response[0]&&String(response[0]._obj).toLowerCase()==="error")
      throw Error(response[0].message||"选中目标图层失败");
  }
  async function selectOriginal(ids,docId){
    for(let i=0;i<ids.length;i++){
      const cmd={_obj:"select",_target:[{_ref:"layer",_id:ids[i]},{_ref:"document",_id:docId}],
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
            if(Math.abs(dx)>0.01||Math.abs(dy)>0.01){
              try{
                await translateById(target,state.docId,dx,dy);
              }catch(error){
                throw Error("无法移动第 "+(i+1)+" 个对象「"+p.item.name+"」（图层ID "+target.id+"）："+(error.message||error));
              }
            }
          }
        }finally{
          try{await selectOriginal(state.layers.map(x=>x.id),state.docId);}
          catch(error){console.warn("[Smart Arrange] selection restore:",error);}
          await ctx.hostControl.resumeHistory(token);
        }
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
  root.querySelectorAll("#saMeasure button").forEach(b=>b.addEventListener("click",async()=>{state.measure=b.dataset.value;state.forceVisible=state.measure==="visible";state.forceBounds=state.measure==="bounds";active("saMeasure",state.measure);try{await read();}catch(e){status(e.message,true);}}));
  $("saReset").addEventListener("click",()=>{
    state.layout="grid";state.flow="row";state.corner="tl";state.spacingMode="uniform";state.forceVisible=false;state.forceBounds=false;active("saSpacingMode","uniform");
    [["saCount",6],["saRows",2],["saCols",3],["saGapX",20],["saGapY",20]].forEach(p=>$(p[0]).value=p[1]);
    $("saAuto").checked=false;
    active("saLayout","grid");active("saFlow","row");active("saCorner","tl");update();preview();
  });
  root.__smartArrangeActivate=async()=>{try{await read();}catch(e){status(e.message,true);preview();}};
  update();root.__smartArrangeActivate();
};
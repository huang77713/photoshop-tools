/* Smart Arrange - Photoshop UXP */
module.exports = function(root) {
  "use strict";
  const photoshop=require("photoshop"),app=photoshop.app,core=photoshop.core;
  const $=id=>root.querySelector("#"+id);
  const state={op:"copy",layout:"grid",flow:"row",corner:"tl",layers:[],docId:null,busy:false};
  const count=(id,min,max,d)=>{const n=Number($(id).value);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):d;};
  function unit(v){return typeof v==="number"?v:(v&&typeof v.value==="number"?v.value:(v&&typeof v._value==="number"?v._value:Number(v)));}
  function bounds(layer){
    const b=layer.boundsNoEffects||layer.bounds;
    const x={l:unit(b.left),t:unit(b.top),r:unit(b.right),b:unit(b.bottom)};
    x.w=x.r-x.l;x.h=x.b-x.t;
    if(Object.values(x).some(v=>!Number.isFinite(v))||x.w<=0||x.h<=0)throw Error("对象没有有效可见边界："+layer.name);
    return x;
  }
  function status(str,err){$("saStatus").textContent=str;$("saStatus").className="sa-status"+(err?" error":"");}
  function active(id,val){root.querySelectorAll("#"+id+" button").forEach(b=>b.classList.toggle("active",b.dataset.value===val));}
  function update(){
    const grid=state.layout==="grid",copy=state.op==="copy";
    $("saQuantity").style.display=copy&&!grid?"flex":"none";
    $("saGridFields").style.display=grid?"flex":"none";
    $("saAutoWrap").style.display=grid&&!copy?"flex":"none";
    $("saFlowWrap").style.display=grid?"block":"none";
    $("saRows").disabled=$("saAuto").checked;
    $("saGapX").disabled=state.layout==="vertical";
    $("saGapY").disabled=state.layout==="horizontal";
    $("saHint").textContent=copy?"一个图层或组：原对象 + 复制对象。":"至少两个对象：移动原图层，不生成副本。";
    $("saRun").textContent=copy?"生成复制排列":"整理选中对象";
  }
  function read(){
    const doc=app.activeDocument;
    if(!doc)throw Error("请先打开 Photoshop 文档。");
    const picked=Array.from(doc.activeLayers||[]);
    if(!picked.length)throw Error("请在 PS 图层面板选中图层或组。");
    const entries=picked.map(layer=>({layer,id:layer.id,name:layer.name,b:bounds(layer)}));
    entries.forEach(e=>{let parent=e.layer.parent;while(parent){if(entries.some(x=>x.id===parent.id))throw Error("不能同时排列父组及组内子图层。");parent=parent.parent;}});
    state.layers=entries;state.docId=doc.id;
    $("saSelected").textContent=entries.length===1?entries[0].name:entries.length+" 个对象已选中";
    $("saDetail").textContent=entries.length===1?Math.round(entries[0].b.w)+" × "+Math.round(entries[0].b.h)+" px · "+(entries[0].layer.layers?"图层组":"图层"):entries.slice(0,3).map(e=>e.name).join("、")+(entries.length>3?"…":"");
    if(entries.length>1){state.op="organize";active("saOp","organize");}
    else {state.op="copy";active("saOp","copy");}
    update();preview();status("已读取当前选择，可以设置间距后生成。");
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
    const cells=list.map((item,i)=>{
      let r,c;
      if(state.layout==="horizontal"){r=0;c=i;}
      else if(state.layout==="vertical"){r=i;c=0;}
      else if(state.flow==="column"){r=i%rows;c=Math.floor(i/rows);}
      else {r=Math.floor(i/cols);c=i%cols;}
      colWidth[c]=Math.max(colWidth[c],item.b.w);rowHeight[r]=Math.max(rowHeight[r],item.b.h);
      return {item,i,r,c};
    });
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
      return {...cell,x:originX+X[c],y:originY+Y[r]};
    });
    return {placements,width,height,gx,gy};
  }
  function preview(){
    const surface=$("saPreview");surface.innerHTML="";
    try{
      const p=getPlan();
      const scale=Math.min(1,300/Math.max(1,p.width),170/Math.max(1,p.height));
      const stage=document.createElement("div");stage.className="sa-stage";
      stage.style.width=Math.max(10,p.width*scale)+"px";stage.style.height=Math.max(10,p.height*scale)+"px";
      const minX=Math.min(...p.placements.map(o=>o.x)),minY=Math.min(...p.placements.map(o=>o.y));
      p.placements.forEach((o,i)=>{
        const el=document.createElement("div");el.className="sa-tile"+(i===0?" first":"");
        el.style.left=(o.x-minX)*scale+"px";el.style.top=(o.y-minY)*scale+"px";
        el.style.width=Math.max(3,o.item.b.w*scale)+"px";el.style.height=Math.max(3,o.item.b.h*scale)+"px";
        el.textContent=String(i+1);stage.appendChild(el);
      });surface.appendChild(stage);
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
      if(!doc||doc.id!==state.docId)throw Error("文档已切换，请重新读取。");
      const now=Array.from(doc.activeLayers||[]).map(l=>l.id).sort().join(",");
      const old=state.layers.map(o=>o.id).sort().join(",");
      if(now!==old)throw Error("图层选择发生变化，请重新读取。");
      for(const item of state.layers){const b=bounds(item.layer);if(Math.abs(b.l-item.b.l)>0.5||Math.abs(b.t-item.b.t)>0.5||Math.abs(b.w-item.b.w)>0.5||Math.abs(b.h-item.b.h)>0.5)throw Error("对象位置或尺寸已变化，请重新读取。");}
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
            const dx=p.x-b.l,dy=p.y-b.t;
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
  $("saRead").addEventListener("click",()=>{try{read();}catch(e){status(e.message,true);}});
  $("saRun").addEventListener("click",generate);
  $("saReset").addEventListener("click",()=>{
    state.layout="grid";state.flow="row";state.corner="tl";
    [["saCount",6],["saRows",2],["saCols",3],["saGapX",20],["saGapY",20]].forEach(p=>$(p[0]).value=p[1]);
    $("saAuto").checked=false;
    active("saLayout","grid");active("saFlow","row");active("saCorner","tl");update();preview();
  });
  root.__smartArrangeActivate=()=>{try{read();}catch(e){status(e.message,true);preview();}};
  update();root.__smartArrangeActivate();
};
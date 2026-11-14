/* Bounds Frame - Photoshop UXP. Independent of Smart Arrange. */
module.exports = function initBoundsFrame(root) {
  "use strict";
  const ps = require("photoshop"), app = ps.app, core = ps.core, imaging = ps.imaging;
  const $ = id => root.querySelector("#" + id);
  let busy = false, snapshot = null;
  const scalar = v => typeof v === "number" ? v : Number(v && (v.value !== undefined ? v.value : v._value));
  function rect(layer) {
    const b = layer.boundsNoEffects || layer.bounds;
    const v = { l:scalar(b.left), t:scalar(b.top), r:scalar(b.right), b:scalar(b.bottom) };
    v.w=v.r-v.l;v.h=v.b-v.t;
    if (![v.l,v.t,v.r,v.b,v.w,v.h].every(Number.isFinite) || v.w<=0 || v.h<=0)
      throw Error("无有效边界：" + layer.name);
    return v;
  }
  function pathOf(doc, layer) {
    const path=[]; let node=layer;
    while(node && node.id!==doc.id) {
      const parent=node.parent;
      const siblings=Array.from(parent && parent.id!==doc.id ? parent.layers : doc.layers);
      const i=siblings.findIndex(x=>x.id===node.id);
      if(i<0)throw Error("无法定位图层：" + layer.name);
      path.unshift(i);
      if(!parent || parent.id===doc.id)break;
      node=parent;
    }
    return path;
  }
  function descendants(layers) {
    const result=[];
    for(const layer of Array.from(layers||[])) {
      result.push(layer);
      if(layer.layers)result.push(...descendants(layer.layers));
    }
    return result;
  }
  function pickedTargets(doc) {
    const picked=Array.from(doc.activeLayers || []);
    if(!picked.length)throw Error("请先在图层面板选中图层或组。");
    const ids=new Set(picked.map(x=>x.id));
    const filtered=picked.filter(layer=>{
      let parent=layer.parent;
      while(parent && parent.id!==doc.id) {
        if(ids.has(parent.id))return false;
        parent=parent.parent;
      }
      return true;
    });
    return filtered.map(layer=>({layer,id:layer.id,name:layer.name,path:pathOf(doc,layer),raw:rect(layer),box:null}));
  }
  async function alphaBox(copyDoc, path) {
    const layers=descendants(copyDoc.layers);
    // A duplicate document, never the original PSD, is changed for isolation.
    const visibility=new Map(layers.map(l=>[l.id,l.visible]));
    let siblings=Array.from(copyDoc.layers);
    for(const index of path) {
      const target=siblings[index];
      if(!target)throw Error("临时文档层级变化");
      for(const l of siblings)l.visible=l.id===target.id;
      siblings=Array.from(target.layers||[]);
    }
    const sizeW=Number(copyDoc.width),sizeH=Number(copyDoc.height),limit=1400;
    const scale=Math.min(1,limit/Math.max(sizeW,sizeH));
    const o={documentID:copyDoc.id,componentSize:8,colorSpace:"RGB",applyAlpha:false,
      sourceBounds:{left:0,top:0,right:sizeW,bottom:sizeH}};
    if(scale<1)o.targetSize={width:Math.max(1,Math.round(sizeW*scale)),height:Math.max(1,Math.round(sizeH*scale))};
    let image;
    try {
      const result=await imaging.getPixels(o);
      image=result.imageData;
      if(!image || image.components!==4)throw Error("无法获取 RGBA 像素");
      const pixels=await image.getData({chunky:true}),w=image.width,h=image.height,c=image.components;
      let minX=w,minY=h,maxX=-1,maxY=-1;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
        if(pixels[(y*w+x)*c+3]>12) {
          minX=Math.min(minX,x);minY=Math.min(minY,y);
          maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
        }
      }
      if(maxX<0)throw Error("没有可见像素");
      const b=result.sourceBounds||o.sourceBounds,lev=Math.pow(2,Math.max(0,Number(result.level)||0));
      const x=Number(b.left)*lev,y=Number(b.top)*lev;
      const dw=(Number(b.right)-Number(b.left))*lev,dh=(Number(b.bottom)-Number(b.top))*lev;
      return {l:x+minX*dw/w,t:y+minY*dh/h,r:x+(maxX+1)*dw/w,b:y+(maxY+1)*dh/h};
    } finally {if(image)image.dispose();}
  }
  function say(message,error) { $("bfStatus").textContent=message; $("bfStatus").className="bf-status"+(error?" bf-error":""); }
  function syncSwatch() {
    const color=$("bfColor").value;
    $("bfSwatch").style.background=color;
    $("bfHex").value=color.toUpperCase();
  }
  function hexRgb(hex) {
    const text=String(hex||"").trim();
    if(!/^#[0-9a-fA-F]{6}$/.test(text))throw Error("请输入 #RRGGBB 格式的颜色。");
    return [1,3,5].map(i=>parseInt(text.substring(i,i+2),16));
  }
  function number(id,min,max) {
    const v=Number($(id).value);
    if(!Number.isFinite(v))throw Error("参数不是有效数字。");
    return Math.max(min,Math.min(max,Math.round(v)));
  }
  function positiveDimension(id) {
    const value=Number($(id).value);
    if(!Number.isFinite(value) || value<2 || value>100000 || !Number.isInteger(value))
      throw Error("统一尺寸需要 2–100000 之间的整数像素。");
    return value;
  }
  function options() {
    return {rgb:hexRgb($("bfColor").value),opacity:number("bfOpacity",0,100),
      stroke:number("bfStroke",1,12),dash:number("bfDash",2,60),
      margin:number("bfMargin",0,100),group:$("bfGroup").checked,
      precise:$("bfPrecise").checked,
      sizeMode:root.querySelector('input[name="bfSizeMode"]:checked').value,
      fixedWidth:positiveDimension("bfWidth"),fixedHeight:positiveDimension("bfHeight")};
  }
  async function read(precise) {
    const doc=app.activeDocument;
    if(!doc)throw Error("请先打开 Photoshop 文档。");
    const items=pickedTargets(doc);
    if(items.length>80)throw Error("单次最多处理 80 个对象。");
    if(precise) {
      await core.executeAsModal(async()=>{
        let copy;
        try {
          copy=await doc.duplicate("边界框_临时测量",false);
          const all=descendants(copy.layers);
          const original=new Map(all.map(l=>[l.id,l.visible]));
          for(const item of items) {
            for(const layer of all)layer.visible=original.get(layer.id);
            try { item.box=await alphaBox(copy,item.path); }
            catch(error) {
              item.box=item.raw;item.fallback=String(error.message||error);
            }
          }
        } finally {
          if(copy)await copy.close(ps.constants.SaveOptions.DONOTSAVECHANGES);
        }
      },{commandName:"边界框：临时读取"});
    } else items.forEach(i=>{i.box=i.raw;});
    snapshot={docId:doc.id,items,precise};
    $("bfCount").textContent=items.length+" 个对象";
    $("bfNames").textContent=items.slice(0,4).map(i=>i.name).join("、")+(items.length>4?"…":"");
    const fallback=items.filter(i=>i.fallback);
    say("已读取 "+items.length+" 个对象"+(fallback.length?"；"+fallback.length+" 个对象已回退到图层边界":"")+".",!!fallback.length);
    return snapshot;
  }
  function targetFrameBounds(box,opt) {
    if(opt.sizeMode!=="fixed")return box;
    const centerX=(box.l+box.r)/2,centerY=(box.t+box.b)/2;
    const left=Math.round(centerX-opt.fixedWidth/2),top=Math.round(centerY-opt.fixedHeight/2);
    return {l:left,t:top,r:left+opt.fixedWidth,b:top+opt.fixedHeight};
  }
  function raster(box, opt, doc) {
    const pad=opt.sizeMode==="fixed"?0:opt.margin,s=opt.stroke,d=opt.dash,[r,g,b]=opt.rgb;
    const left=Math.max(0,Math.floor(box.l-pad)),top=Math.max(0,Math.floor(box.t-pad));
    const right=Math.min(Number(doc.width),Math.ceil(box.r+pad));
    const bottom=Math.min(Number(doc.height),Math.ceil(box.b+pad));
    const w=right-left,h=bottom-top;
    if(opt.sizeMode==="fixed" && (w!==opt.fixedWidth || h!==opt.fixedHeight))
      throw Error("统一尺寸框超出画布边缘，无法保持完整宽高；请移动对象或调小尺寸。");
    if(w<2 || h<2)throw Error("矩形范围过小或完全位于画布外。");
    if(w*h>18000000)throw Error("框尺寸过大（超过 1800 万像素），请缩小对象后再试。");
    const data=new Uint8Array(w*h*4),fill=Math.round(opt.opacity*255/100);
    // Border is anchored to the object bounds rather than the canvas crop.
    const L=Math.max(0,Math.round(box.l-pad-left)),T=Math.max(0,Math.round(box.t-pad-top));
    const R=Math.min(w-1,Math.round(box.r+pad-left)-1),B=Math.min(h-1,Math.round(box.b+pad-top)-1);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
      if(x<L||x>R||y<T||y>B)continue;
      const edge=(x<L+s || x>R-s || y<T+s || y>B-s);
      let ink=false;
      if(edge) {
        // Same dash cadence on all four edges with a continuous perimeter.
        const dx=x-L,dy=y-T,perimeter=2*((R-L)+(B-T));
        let p;
        if(dy<s)p=dx;
        else if(dx>R-L-s)p=(R-L)+dy;
        else if(dy>B-T-s)p=(R-L)+(B-T)+(R-x);
        else p=2*(R-L)+(B-T)+(B-y);
        ink=perimeter<=0 || p%(d*2)<d;
      }
      const at=(y*w+x)*4;
      data[at]=r;data[at+1]=g;data[at+2]=b;
      data[at+3]=ink?255:fill;
    }
    return {left,top,w,h,data};
  }
  async function restoreSelection(doc,ids) {
    if(!ids.length)return;
    await ps.action.batchPlay([{_obj:"select",_target:[{_ref:"layer",_id:ids[0]}],
      makeVisible:false,layerID:ids,selectionModifier:{_enum:"selectionModifierType",_value:"addToSelection"},_options:{dialogOptions:"dontDisplay"}}],{synchronousExecution:false});
  }
  async function create() {
    if(busy)return;
    busy=true;$("bfGenerate").disabled=true;$("bfRead").disabled=true;
    try {
      const opt=options(),doc=app.activeDocument;
      if(!doc)throw Error("请先打开 Photoshop 文档。");
      // Snapshot selections BEFORE creating layers; Photoshop changes the active selection.
      const fresh=pickedTargets(doc),selectedIds=fresh.map(i=>i.id);
      const cached=snapshot && snapshot.docId===doc.id && snapshot.precise===opt.precise &&
        snapshot.items.length===fresh.length && fresh.every(x=>snapshot.items.some(y=>y.id===x.id &&
          JSON.stringify(y.raw)===JSON.stringify(x.raw)));
      if(!cached)await read(opt.precise);
      const items=snapshot.items.slice().sort((a,b)=>{
        for(let i=0;i<Math.min(a.path.length,b.path.length);i++)if(a.path[i]!==b.path[i])return a.path[i]-b.path[i];
        return a.path.length-b.path.length;
      });
      say("正在生成 "+items.length+" 个独立矩形框…");
      await core.executeAsModal(async ctx=>{
        const token=await ctx.hostControl.suspendHistory({documentID:doc.id,name:"批量生成边界框"});
        try {
          for(const item of items) {
            const source=item.layer;
            const result=raster(targetFrameBounds(item.box,opt),opt,doc);
            const frame=await doc.createLayer({name:item.name+" - 边界框"});
            let pixels;
            try {
              pixels=await imaging.createImageDataFromBuffer(result.data,{
                width:result.w,height:result.h,components:4,chunky:true,
                colorSpace:"RGB",colorProfile:"sRGB IEC61966-2.1"
              });
              await imaging.putPixels({documentID:doc.id,layerID:frame.id,imageData:pixels,
                targetBounds:{left:result.left,top:result.top},replace:true});
            }finally{if(pixels)pixels.dispose();}
            // Move below the entire original group, not inside it.
            frame.move(source,ps.constants.ElementPlacement.PLACEAFTER);
            if(opt.group) {
              const wrapper=await doc.createLayerGroup({name:item.name+" - 边界框组"});
              wrapper.move(source,ps.constants.ElementPlacement.PLACEBEFORE);
              source.move(wrapper,ps.constants.ElementPlacement.PLACEINSIDE);
              frame.move(wrapper,ps.constants.ElementPlacement.PLACEINSIDE);
              source.move(frame,ps.constants.ElementPlacement.PLACEBEFORE);
            }
          }
        } finally {
          try {await restoreSelection(doc,selectedIds);} catch(e) {console.warn("[Bounds Frame] restore selection:",e);}
          await ctx.hostControl.resumeHistory(token);
        }
      },{commandName:"批量生成边界框"});
      snapshot=null;
      say("完成！已为 "+items.length+" 个对象分别生成矩形框，可使用 Ctrl+Z 撤销。");
    }catch(error) {
      say("生成失败："+String(error.message||error)+"；如有部分生成，可按 Ctrl+Z 撤销。",true);
      console.error("[Bounds Frame]",error);
    }finally{busy=false;$("bfGenerate").disabled=false;$("bfRead").disabled=false;}
  }
  function syncSizeMode() {
    const fixed=root.querySelector('input[name="bfSizeMode"]:checked').value==="fixed";
    $("bfFixedDimensions").style.display=fixed?"flex":"none";
    $("bfMargin").disabled=fixed;
    $("bfMarginNote").textContent=fixed
      ?"统一尺寸以每个对象的可见范围中心对齐；留白不再额外叠加。"
      :"边缘留白只在跟随对象尺寸时生效。";
  }
  root.querySelectorAll('input[name="bfSizeMode"]').forEach(input=>input.addEventListener("change",syncSizeMode));
  $("bfColor").addEventListener("input",syncSwatch);
  $("bfHex").addEventListener("change",()=>{
    const v=$("bfHex").value.trim();
    if(/^#[0-9a-f]{6}$/i.test(v)){$("bfColor").value=v;syncSwatch();}
    else say("色值格式应为 #RRGGBB。",true);
  });
  $("bfRead").addEventListener("click",async()=>{if(busy)return;busy=true;$("bfRead").disabled=true;
    try{await read($("bfPrecise").checked);}catch(e){say(e.message||String(e),true);}
    finally{busy=false;$("bfRead").disabled=false;}});
  $("bfGenerate").addEventListener("click",create);
  $("bfPrecise").addEventListener("change",()=>{snapshot=null;say("测量模式已切换，生成前会重新读取。");});
  root.__boundsFrameActivate=()=>{snapshot=null;say("选择图层或组，点击「读取对象」或直接生成。");};
  syncSwatch();syncSizeMode();
};
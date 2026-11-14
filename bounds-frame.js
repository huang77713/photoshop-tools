/* Bounds Frame - Photoshop UXP. Independent of Smart Arrange. */
module.exports = function initBoundsFrame(root) {
  "use strict";
  const ps = require("photoshop"), app = ps.app, core = ps.core, imaging = ps.imaging;
  const $ = id => root.querySelector("#" + id);
  let busy = false, snapshot = null;
  const uiState={sizeMode:"auto",group:false,precise:true};
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
  let currentColor="#20CF52";
  function setColor(value) {
    const hex=String(value||"").trim().toUpperCase();
    if(!/^#[0-9A-F]{6}$/.test(hex))throw Error("请输入 #RRGGBB 格式的颜色。");
    currentColor=hex;
    $("bfSwatch").style.backgroundColor=hex;
    $("bfHex").value=hex;
  }
  async function openPicker() {
    if(busy)return;
    busy=true;$("bfPick").disabled=true;
    try {
      // UXP does not implement HTML input[type=color]; use Photoshop native picker.
      const result=await core.executeAsModal(async()=>{
        const output=await ps.action.batchPlay([
          {_obj:"showColorPicker",_target:[{_ref:"application"}],context:"边界框颜色",color:rgbDescriptor(hexRgb(currentColor))}
        ],{synchronousExecution:false});
        return output && output[0];
      },{commandName:"选择边界框颜色"});
      const rgb=result && (result.RGBFloatColor||result.RGBColor);
      if(rgb) {
        const components=[rgb.red,rgb.grain!==undefined?rgb.grain:rgb.green,rgb.blue];
        if(components.every(v=>Number.isFinite(Number(v)))) {
          const normalized=components.map(Number);
          const multiplier=Math.max(...normalized)<=1?255:1;
          const hex=normalized.map(v=>Math.max(0,Math.min(255,Math.round(v*multiplier))).toString(16).padStart(2,"0")).join("");
          setColor("#"+hex);
        }
      } else if(result && /error/i.test(result._obj||"")) {
        throw Error(result.message||"无法打开 Photoshop 选色器");
      }
    }catch(error){say("颜色选择失败："+(error.message||error),true);}
    finally{busy=false;$("bfPick").disabled=false;}
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
  // Round dimensions normally, then advance odd values to the next even pixel.
  function evenDimension(value) {
    const rounded=Math.max(2,Math.round(value));
    return rounded%2===0?rounded:rounded+1;
  }
  function positiveDimension(id) {
    const value=Number($(id).value);
    if(!Number.isFinite(value) || value<2 || value>100000)
      throw Error("统一尺寸需要 2–100000 之间的有效像素数值。");
    return evenDimension(value);
  }
  function options() {
    return {rgb:hexRgb(currentColor),opacity:number("bfOpacity",0,100),
      stroke:number("bfStroke",1,12),dash:number("bfDash",2,60),
      margin:number("bfMargin",0,100),group:uiState.group,
      precise:uiState.precise,
      sizeMode:uiState.sizeMode,
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
    const centerX=(box.l+box.r)/2,centerY=(box.t+box.b)/2;
    const margin=opt.sizeMode==="fixed"?0:opt.margin;
    const width=opt.sizeMode==="fixed"?opt.fixedWidth:evenDimension(box.r-box.l+margin*2);
    const height=opt.sizeMode==="fixed"?opt.fixedHeight:evenDimension(box.b-box.t+margin*2);
    const left=Math.round(centerX-width/2),top=Math.round(centerY-height/2);
    return {l:left,t:top,r:left+width,b:top+height};
  }
  function rgbDescriptor(rgb) {
    return {_obj:"RGBColor",red:rgb[0],grain:rgb[1],blue:rgb[2]};
  }
  function pixel(v) {return {_unit:"pixelsUnit",_value:v};}
  function point(v) {return {_unit:"pointsUnit",_value:v};}
  async function makeVectorFrame(doc,box,opt,name) {
    // targetFrameBounds has already applied margins, integer coordinates,
    // and even dimensions. Do not apply padding a second time.
    const left=box.l,top=box.t,right=box.r,bottom=box.b;
    if(![left,top,right,bottom].every(Number.isFinite) || right-left<2 || bottom-top<2)
      throw Error("无法生成尺寸无效的矢量矩形。");
    // Shape paths may extend beyond the canvas, but no pixel raster is cropped.
    // Native vector fill, stroke width, color and dash array remain editable.
    const dash=opt.dash,stroke=opt.stroke;
    const descriptor={
      _obj:"make",_target:[{_ref:"contentLayer"}],
      using:{
        _obj:"contentLayer",
        name:name,
        type:{_obj:"solidColorLayer",color:rgbDescriptor(opt.rgb)},
        shape:{_obj:"rectangle",unitValueQuadVersion:1,top:pixel(top),left:pixel(left),bottom:pixel(bottom),right:pixel(right),topLeft:pixel(0),topRight:pixel(0),bottomLeft:pixel(0),bottomRight:pixel(0)},
        strokeStyle:{
          _obj:"strokeStyle",strokeStyleVersion:2,
          strokeEnabled:true,fillEnabled:true,
          strokeStyleLineWidth:pixel(stroke),
          strokeStyleLineDashOffset:point(0),
          strokeStyleMiterLimit:100,
          strokeStyleLineCapType:{_enum:"strokeStyleLineCapType",_value:"strokeStyleButtCap"},
          strokeStyleLineJoinType:{_enum:"strokeStyleLineJoinType",_value:"strokeStyleMiterJoin"},
          strokeStyleLineAlignment:{_enum:"strokeStyleLineAlignment",_value:"strokeStyleAlignInside"},
          strokeStyleScaleLock:false,strokeStyleStrokeAdjust:false,
          strokeStyleLineDashSet:[point(dash),point(dash)],
          strokeStyleBlendMode:{_enum:"blendMode",_value:"normal"},
          strokeStyleOpacity:{_unit:"percentUnit",_value:100},
          strokeStyleContent:{_obj:"solidColorLayer",color:rgbDescriptor(opt.rgb)},
          strokeStyleResolution:72
        }
      },
      _options:{dialogOptions:"dontDisplay"}
    };
    const response=await ps.action.batchPlay([descriptor],{synchronousExecution:false});
    if(!response || !response[0] || /error/i.test(response[0]._obj||""))
      throw Error("Photoshop 创建矢量形状失败："+(response&&response[0]&&response[0].message||"未知错误"));
    const frame=Array.from(doc.activeLayers||[])[0];
    if(!frame || frame.id===undefined || (ps.constants.LayerKind.SOLIDFILL && frame.kind!==ps.constants.LayerKind.SOLIDFILL))
      throw Error("未能确认新建的形状图层，请检查 Photoshop 日志。");
    frame.name=name;
    frame.fillOpacity=opt.opacity;
    return frame;
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
            const frame=await makeVectorFrame(doc,targetFrameBounds(item.box,opt),opt,item.name+" - 边界框");
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
    const fixed=uiState.sizeMode==="fixed";
    $("bfFixedDimensions").style.display=fixed?"flex":"none";
    $("bfMargin").disabled=fixed;
    $("bfMarginNote").textContent=fixed
      ?"统一尺寸以每个对象的可见范围中心对齐；留白不再额外叠加。"
      :"边缘留白只在跟随对象尺寸时生效。";
  }
  function syncChoices(){
    root.querySelectorAll(".bf-choice[data-mode]").forEach(button=>{
      const active=button.getAttribute("data-mode")===uiState.sizeMode;
      button.classList.toggle("bf-selected",active);
      button.setAttribute("aria-pressed",String(active));
    });
    [["bfGroup",uiState.group],["bfPrecise",uiState.precise]].forEach(pair=>{
      const button=$(pair[0]),active=pair[1];
      button.classList.toggle("bf-selected",active);
      button.setAttribute("aria-pressed",String(active));
    });
    syncSizeMode();
  }
  root.querySelectorAll(".bf-choice[data-mode]").forEach(button=>button.addEventListener("click",()=>{
    uiState.sizeMode=button.getAttribute("data-mode");
    syncChoices();
  }));
  $("bfGroup").addEventListener("click",()=>{uiState.group=!uiState.group;syncChoices();});
  $("bfPrecise").addEventListener("click",()=>{
    uiState.precise=!uiState.precise;snapshot=null;
    syncChoices();say("测量模式已切换，生成前会重新读取。");
  });
  $("bfPick").addEventListener("click",openPicker);
  $("bfHex").addEventListener("change",()=>{
    try {setColor($("bfHex").value);}
    catch(error){say(error.message,true);setColor(currentColor);}
  });
  $("bfRead").addEventListener("click",async()=>{if(busy)return;busy=true;$("bfRead").disabled=true;
    try{await read(uiState.precise);}catch(e){say(e.message||String(e),true);}
    finally{busy=false;$("bfRead").disabled=false;}});
  $("bfGenerate").addEventListener("click",create);
  root.__boundsFrameActivate=()=>{snapshot=null;say("选择图层或组，点击「读取对象」或直接生成。");};
  setColor(currentColor);syncChoices();
};
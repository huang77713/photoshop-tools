/* Nine Slice Resize: functional code from original repository.
   Only change: DOM operations are restricted to the selected panel view.
   Processing algorithms and Photoshop actions are unchanged. */
module.exports = function mountNineSlice(root) {
/* Nine Slice Resize - UXP Photoshop. No external dependencies. */
const ps = require('photoshop');
const { app, imaging, core, action } = ps;
const $ = id => root.querySelector('#' + id);
const sourceCanvas = $('sourceCanvas'), resultCanvas = $('outputCanvas');
const sw = $('sourceWrap'), guides = $('guides');
let source = null, drag = null, busy = false, aspectLocked = false;
let autoTimer=null, autoPending=false, readingLayer=false, readGeneration=0;
const int = id => Math.round(Number($(id).value));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const status = (s, mode='') => { $('status').textContent=s; $('status').className='hint '+mode; $('status').title=s; };
let lastFailure='';
const set = (id, n) => { $(id).value = Math.round(n); };
function setAspectLock(locked){
  aspectLocked=!!locked;
  $('aspectLock').setAttribute('aria-pressed',aspectLocked?'true':'false');
  $('aspectLock').title=aspectLocked?'已锁定原图比例，点击解除':'自由调整宽高，点击锁定原图比例';
  const icon=$('aspectLockIcon');
  if(icon)icon.src=aspectLocked?icon.dataset.closed:icon.dataset.open;
}
function updateOriginalSize(){
  $('originalSize').textContent=source?'原图 '+source.width+' × '+source.height+' px':'原图：读取后显示';
  $('originalWidth').textContent=source?'原图：'+source.width:'原图：—';
  $('originalHeight').textContent=source?'原图：'+source.height:'原图：—';
}
function sizeEdited(changed){
  if(aspectLocked && source){
    const value=Number($(changed).value);
    if(Number.isFinite(value) && value>0 && Number.isInteger(value)){
      const other=changed==='width'?'height':'width';
      const ratio=changed==='width'?source.height/source.width:source.width/source.height;
      const calculated=Math.round(value*ratio);
      if(calculated>=1 && calculated<=12000)set(other,calculated);
    }
  }
  queueRender();
}
function params(){
  if (!source) throw new Error(lastFailure || '请先读取选中的图层');
  const l=int('left'),r=int('right'),t=int('top'),b=int('bottom');
  const w=int('width'),h=int('height');
  if (![l,r,t,b,w,h].every(Number.isFinite)) throw new Error('请填写有效的整数尺寸');
  if (l<0||r<0||t<0||b<0||l+r>=source.width||t+b>=source.height) throw new Error('九宫格中间区域必须至少保留 1 像素');
  if(w<1||h<1||w>12000||h>12000) throw new Error('输出尺寸须介于 1~12000 像素');
  if (w<l+r+1||h<t+b+1) throw new Error('输出尺寸太小，容纳不下四角固定区域');
  if (w*h>45000000) throw new Error('单次最多处理 4500 万像素，避免 PS 内存不足');
  return {l,r,t,b,w,h,mode:root.querySelector('input[name=mode]:checked').value};
}
// UXP Canvas is not a browser Canvas: pixel drawing APIs are unavailable.
// All sampling/compositing is done in plain JavaScript RGBA arrays.
function sampleRGBA(buffer,w,h,x,y,out,at){
  // Bilinear filtering on premultiplied colors prevents dark fringes on transparent PNGs.
  x=clamp(x,0,w-1);y=clamp(y,0,h-1);
  const x0=Math.floor(x),y0=Math.floor(y),x1=Math.min(w-1,x0+1),y1=Math.min(h-1,y0+1);
  const fx=x-x0,fy=y-y0;
  const indexes=[(y0*w+x0)*4,(y0*w+x1)*4,(y1*w+x0)*4,(y1*w+x1)*4];
  const weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy];
  let alpha=0,rr=0,gg=0,bb=0;
  for(let k=0;k<4;k++){
    const i=indexes[k],wa=weights[k]*(buffer[i+3]/255);
    alpha+=wa;rr+=buffer[i]*wa;gg+=buffer[i+1]*wa;bb+=buffer[i+2]*wa;
  }
  out[at+3]=Math.round(alpha*255);
  if(alpha>0.000001){out[at]=Math.round(rr/alpha);out[at+1]=Math.round(gg/alpha);out[at+2]=Math.round(bb/alpha);}
  else {out[at]=0;out[at+1]=0;out[at+2]=0;}
}
function ninePixels(w,h,p){
  const output=new Uint8Array(w*h*4), iw=source.width,ih=source.height;
  const sx=[0,p.l,iw-p.r,iw],sy=[0,p.t,ih-p.b,ih];
  const DX=[0,p.l/p.w*w,w-p.r/p.w*w,w], DY=[0,p.t/p.h*h,h-p.b/p.h*h,h];
  // Preview is scaled as a whole; the source corner proportions remain correct.
  const xMap=new Float64Array(w),yMap=new Float64Array(h);
  function buildMap(dst,ends,sourceEnds,scale){
    for(let j=0;j<dst.length;j++){
      const pos=j+0.5;let part=pos<ends[1]?0:(pos<ends[2]?1:2);
      const d0=ends[part],dw=ends[part+1]-d0,s0=sourceEnds[part],sw=sourceEnds[part+1]-s0;
      if(p.mode==='tile' && part===1){
        const tileSpan=Math.max(1e-6,sw*scale);
        dst[j]=s0+((((pos-d0)%tileSpan)+tileSpan)%tileSpan)/scale-0.5;
      }else dst[j]=s0+((pos-d0)/Math.max(dw,1e-9))*sw-0.5;
      dst[j]=clamp(dst[j],s0,sourceEnds[part+1]-1);
    }
  }
  buildMap(xMap,DX,sx,w/p.w);buildMap(yMap,DY,sy,h/p.h);
  for(let y=0;y<h;y++){for(let x=0;x<w;x++){
    sampleRGBA(source.rgba,iw,ih,xMap[x],yMap[y],output,(y*w+x)*4);
  }}
  return output;
}
function checkerboardComposite(raw,w,h){
  const out=new Uint8Array(w*h*3);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const j=(y*w+x),i=j*4,a=raw[i+3]/255,bg=79;
    out[j*3]=Math.round(raw[i]*a+bg*(1-a));
    out[j*3+1]=Math.round(raw[i+1]*a+bg*(1-a));
    out[j*3+2]=Math.round(raw[i+2]*a+bg*(1-a));
  }
  return out;
}
async function showPreview(img,rgba,w,h){
  let im;
  try {
    im=await imaging.createImageDataFromBuffer(checkerboardComposite(rgba,w,h),{
      width:w,height:h,components:3,chunky:true,colorSpace:'RGB',colorProfile:'sRGB IEC61966-2.1'
    });
    const jpeg=await imaging.encodeImageData({imageData:im,base64:true});
    img.src='data:image/jpeg;base64,'+jpeg;
    img.dataset.width=String(w);img.dataset.height=String(h);
    img.style.width=w+'px';img.style.height=h+'px';
  }finally {if(im)im.dispose();}
}
let renderSerial=0, previewTimer=null;
function queueRender(){
  updateGuides();
  if(previewTimer!==null)clearTimeout(previewTimer);
  previewTimer=setTimeout(()=>{previewTimer=null;render();},80);
}
function updateGuides(){
  if(!source)return;
  const rect=sourceCanvas.getBoundingClientRect(), wrap=sw.getBoundingClientRect();
  guides.style.left=(rect.left-wrap.left)+'px';guides.style.top=(rect.top-wrap.top)+'px';
  guides.style.width=rect.width+'px';guides.style.height=rect.height+'px';
  const setGuide=(name,val,total,axis)=>{const el=root.querySelector('[data-guide='+name+']');el.style[axis]=(val/total*100)+'%';};
  setGuide('left',int('left'),source.width,'left');setGuide('right',source.width-int('right'),source.width,'left');
  setGuide('top',int('top'),source.height,'top');setGuide('bottom',source.height-int('bottom'),source.height,'top');
}
async function render(){
  const serial=++renderSerial;
  try{
    const p=params();
    const resultWrap=$('resultWrap');
    const maxW=Math.max(1,resultWrap.clientWidth-12);
    const maxH=Math.max(1,resultWrap.clientHeight-12);
    const k=Math.min(maxW/p.w,maxH/p.h,1);
    const w=Math.max(1,Math.round(p.w*k)),h=Math.max(1,Math.round(p.h*k));
    const buf=ninePixels(w,h,p);
    if(serial!==renderSerial)return;
    await showPreview(resultCanvas,buf,w,h);
    if(serial!==renderSerial)return;
    $('destLabel').textContent=p.w+' × '+p.h;
    updateGuides();
    if(!busy && !lastFailure)status('已就绪');
  }catch(e){if(serial===renderSerial){$('destLabel').textContent='';status(e.message,'error');updateGuides();}}
}
function currentLayerKey(){
  try{
    const doc=app.activeDocument;
    const layer=doc && (doc.activeLayers||[])[0];
    return doc && layer ? String(doc.id)+':'+String(layer.id) : '';
  }catch(_){return '';}
}
function activePanel(){return root.style.display!=='none';}
function scheduleAutoRead(force){
  if(!activePanel())return;
  if(autoTimer!==null)clearTimeout(autoTimer);
  autoTimer=setTimeout(()=>{
    autoTimer=null;
    if(!activePanel())return;
    const key=currentLayerKey();
    if(!force && source && key===String(source.docID)+':'+String(source.layerID))return;
    if(busy){autoPending=true;return;}
    loadLayer();
  },180);
}
async function loadLayer(){
  if(busy){autoPending=true;return;}
  busy=true;readingLayer=true;source=null;lastFailure='';
  const generation=++readGeneration;
  const requestedKey=currentLayerKey();
  let stage='检查文档',px=null;
  try{
    status('正在读取图层…');
    $('sourceInfo').textContent='正在读取图层…';
    const doc=app.activeDocument;
    if(!doc)throw new Error('未打开 Photoshop 文档');
    const layer=(doc.activeLayers||[])[0];
    if(!layer)throw new Error('没有选中的图层');
    const kind=String(layer.kind||'unknown');
    stage='获取图层边界';
    const bd=layer.boundsNoEffects||layer.bounds;
    if(!bd)throw new Error('图层没有可用的像素边界');
    const number=v => Number(v && typeof v==='object' && 'value' in v ? v.value : v);
    const left=Math.floor(number(bd.left)),top=Math.floor(number(bd.top));
    const right=Math.ceil(number(bd.right)),bottom=Math.ceil(number(bd.bottom));
    if(![left,top,right,bottom].every(Number.isFinite))throw new Error('边界不是有效数值：'+JSON.stringify({left,top,right,bottom}));
    if(right<=left||bottom<=top)throw new Error('图层边界为零，可能是空白图层');
    if((right-left)*(bottom-top)>16000000)throw new Error('图层超过 1600 万像素，请暂时缩小素材测试');
    stage='调用 imaging.getPixels';
    const opts={documentID:doc.id,layerID:layer.id,sourceBounds:{left,top,right,bottom},colorSpace:'RGB',componentSize:8,applyAlpha:false};
    // Reading pixels is a read-only operation. Do not force a modal write transaction.
    try { px=await imaging.getPixels(opts); }
    catch(first){
      console.warn('Non-modal read failed; retrying within modal:',first);
      px=await core.executeAsModal(async()=>await imaging.getPixels(opts),{commandName:'读取九宫格图层'});
    }
    if(!px||!px.imageData)throw new Error('Photoshop 未返回像素数据');
    const image=px.imageData;
    stage='解码像素';
    const w=image.width,h=image.height,comp=image.components;
    if(!w||!h)throw new Error('返回的图层像素尺寸为零');
    if(comp!==3&&comp!==4)throw new Error('需要 RGB/RGBA，实际返回 '+comp+' 通道');
    const raw=await image.getData({chunky:true});
    if(!raw||raw.length!==w*h*comp)throw new Error('返回的像素长度不匹配：'+(raw&&raw.length));
    const rgba=new Uint8ClampedArray(w*h*4);
    for(let i=0,j=0;i<w*h;i++,j+=comp){const d=i*4;rgba[d]=raw[j];rgba[d+1]=raw[j+1];rgba[d+2]=raw[j+2];rgba[d+3]=comp===4?raw[j+3]:255;}
    stage='生成插件预览';
    source={docID:doc.id,layerID:layer.id,layerName:layer.name,width:w,height:h,rgba,bounds:{left,top,right,bottom}};
    await showPreview(sourceCanvas,rgba,w,h);
    if(generation!==readGeneration || requestedKey!==currentLayerKey()){
      autoPending=true;
      return;
    }
    $('sourceInfo').textContent=layer.name+' · '+w+' × '+h+' px · '+kind;
    const x=Math.max(1,Math.floor(w*.22)),y=Math.max(1,Math.floor(h*.22));
    set('left',x);set('right',x);set('top',y);set('bottom',y);
    set('width',w);set('height',h);
    setAspectLock(false);
    updateOriginalSize();
    lastFailure='';status('读取成功：'+layer.name+'（'+w+'×'+h+'）','ok');
    render();
  }catch(e){
    source=null;updateOriginalSize();sourceCanvas.removeAttribute('src');resultCanvas.removeAttribute('src');guides.style.width='0px';guides.style.height='0px';
    lastFailure='读取失败【'+stage+'】：'+(e&&e.message?e.message:String(e));
    console.error('[Nine Slice Resize] '+lastFailure,e);
    $('sourceInfo').textContent=lastFailure;
    $('destLabel').textContent='';
    status(lastFailure,'error');
  }finally{
    if(px&&px.imageData){try{px.imageData.dispose();}catch(_) {}}
    busy=false;readingLayer=false;
    if(autoPending){
      autoPending=false;
      scheduleAutoRead(true);
    }
  }
}
async function generate(newDocument){
  if(busy)return;
  let p;try{p=params();}catch(e){status(e.message,'error');return;}
  if(!newDocument){const cur=app.activeDocument;
    if(!cur||cur.id!==source.docID){status('请切回原文档，或选择生成到新文档','error');return;}
    if(p.w>cur.width||p.h>cur.height){status('新图层不能超出当前画布。请改用“生成到新文档”。','error');return;}
  }
  busy=true;
  let buffer;
  try{
    status('正在计算九宫格像素，请稍候...');
    // True target pixel resolution, computed without unsupported Canvas pixel APIs.
    buffer=ninePixels(p.w,p.h,p);
    const blob=await imaging.createImageDataFromBuffer(buffer,{
      width:p.w,height:p.h,components:4,chunky:true,colorSpace:'RGB',colorProfile:'sRGB IEC61966-2.1'
    });
    try{
      await core.executeAsModal(async()=>{
        let doc;
        if(newDocument){
          doc=await app.documents.add({name:'Nine Slice '+p.w+'x'+p.h,width:p.w,height:p.h,resolution:72,mode:'RGBColorMode',fill:'transparent'});
        }else doc=app.activeDocument;
        const newLayer=await doc.createPixelLayer({name:'Nine Slice · '+p.w+'x'+p.h+' · '+source.layerName});
        await imaging.putPixels({documentID:doc.id,layerID:newLayer.id,imageData:blob,
          targetBounds:{left:0,top:0},replace:true,commandName:'Nine Slice Resize'});
      },{commandName:'Nine Slice Resize'});
      status('生成成功：'+p.w+' × '+p.h+' px','ok');
    }finally{blob.dispose();}
  }catch(e){status('生成失败：'+(e.message||String(e)),'error');console.error(e);}
  finally{
    busy=false;buffer=null;
    if(autoPending){autoPending=false;scheduleAutoRead(true);}
  }
}
$('load').textContent='重新读取';
$('load').addEventListener('click',()=>{if(autoTimer!==null){clearTimeout(autoTimer);autoTimer=null;}loadLayer();});
$('reset').addEventListener('click',()=>{if(!source)return;let a=Math.max(1,Math.floor(source.width*.22)),b=Math.max(1,Math.floor(source.height*.22));set('left',a);set('right',a);set('top',b);set('bottom',b);render();});
['left','right','top','bottom'].forEach(id=>$(id).addEventListener('input',queueRender));
['width','height'].forEach(id=>$(id).addEventListener('input',()=>sizeEdited(id)));
$('aspectLock').addEventListener('click',()=>{
  setAspectLock(!aspectLocked);
  if(aspectLocked && source)sizeEdited('width');
  else queueRender();
});
function selectMode(value){
  root.querySelectorAll('.ns-mode-item').forEach(item=>{
    const selected=item.dataset.mode===value;
    item.classList.toggle('ns-selected',selected);
    const input=item.querySelector('input[name=mode]');
    if(input)input.checked=selected;
    item.setAttribute('aria-checked',selected?'true':'false');
  });
  queueRender();
}
root.querySelectorAll('.ns-mode-item').forEach(item=>{
  item.setAttribute('role','radio');
  item.addEventListener('click',e=>{
    e.preventDefault();
    selectMode(item.dataset.mode);
  });
  item.addEventListener('keydown',e=>{
    if(e.key===' '||e.key==='Enter'){
      e.preventDefault();
      selectMode(item.dataset.mode);
    }
  });
});
selectMode('stretch');
$('newDoc').addEventListener('click',()=>generate(true));$('sameDoc').addEventListener('click',()=>generate(false));
root.querySelectorAll('.guide').forEach(el=>el.addEventListener('pointerdown',e=>{
  if(!source)return;drag=el.dataset.guide;el.setPointerCapture(e.pointerId);e.preventDefault();
}));
root.querySelectorAll('.guide').forEach(el=>el.addEventListener('pointermove',e=>{
  if(!drag||!source)return;let rc=sourceCanvas.getBoundingClientRect();
  const horizontal=drag==='left'||drag==='right';
  const fraction=clamp(horizontal?(e.clientX-rc.left)/rc.width:(e.clientY-rc.top)/rc.height,0,1);
  const dim=horizontal?source.width:source.height;
  let offset=Math.round(fraction*dim);
  if(drag==='right'||drag==='bottom')offset=dim-offset;
  const opposite=({left:'right',right:'left',top:'bottom',bottom:'top'})[drag];
  offset=clamp(offset,0,dim-int(opposite)-1);
  set(drag,offset);queueRender();
}));
root.querySelectorAll('.guide').forEach(el=>{el.addEventListener('pointerup',()=>drag=null);el.addEventListener('pointercancel',()=>drag=null);});
sourceCanvas.addEventListener('load',updateGuides);
if(typeof ResizeObserver!=='undefined'){
  const resizeObserver=new ResizeObserver(()=>{updateGuides();if(source)queueRender();});
  resizeObserver.observe(sw);
  resizeObserver.observe($('resultWrap'));
}
setAspectLock(false);updateOriginalSize();
status('选择 Photoshop 图层后将自动读取');
root.__nineSliceActivate=function(){scheduleAutoRead(false);};
const onSelectionChange=(eventName,descriptor)=>{
  if(!activePanel())return;
  if(eventName==='select'){
    const targets=descriptor&&descriptor._target;
    if(Array.isArray(targets)&&!targets.some(item=>item&&
      (item._ref==='layer'||item._ref==='document')))return;
  }
  scheduleAutoRead(false);
};
try{
  // Photoshop UXP addNotificationListener is synchronous in supported versions.
  // It does not return a Promise, so do not chain .catch() onto its return value.
  action.addNotificationListener(['select','open','close'],onSelectionChange);
}catch(e){
  console.warn('[Nine Slice] 自动读取监听注册失败',e);
  status('自动监听不可用，可点击“重新读取”','error');
}
scheduleAutoRead(true);

};

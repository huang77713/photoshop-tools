/* Text Layer Manager: selection and unified text replacement */
module.exports = function initTextLayerManager(root) {
  "use strict";
  const ps = require("photoshop");
  const {app, action, core, constants} = ps;
  const $ = id => root.querySelector("#" + id);
  let scopeValue = "selection";
  let fitMode = "keep";
  const scopeDropdown = $("tlmScopeDropdown");
  const fitDropdown = $("tlmFitMode");
  scopeDropdown.addEventListener("change", function () {
    const values=["selection","all","visible"];
    const index=Number(scopeDropdown.selectedIndex);
    scopeValue=values[index] || "selection";
  });
  fitDropdown.addEventListener("change", function () {
    fitMode=Number(fitDropdown.selectedIndex)===1 ? "shrink" : "keep";
  });
  let busy = false;
  const clone = x => JSON.parse(JSON.stringify(x));

  function status(message, kind) {
    $("tlmStatus").textContent = message;
    $("tlmStatus").className = "tlm-status" + (kind ? " " + kind : "");
  }
  function doc() {
    if (!app.activeDocument) throw Error("请先打开 PSD 文档");
    return app.activeDocument;
  }
  function textLayer(layer) {
    const kind = String(layer && layer.kind || "").toLowerCase();
    return !!layer && (layer.kind === constants.LayerKind.TEXT || kind === "text" || kind === "3");
  }
  function groupLayer(layer) {
    return !!layer && !!layer.layers && typeof layer.layers.length === "number";
  }
  function walk(layers, out) {
    for (const layer of layers) {
      out.push(layer);
      if (groupLayer(layer)) walk(Array.from(layer.layers), out);
    }
    return out;
  }
  function layersInScope(scope) {
    const d = doc();
    if (scope !== "visible") {
      return walk(Array.from(scope === "all" ? d.layers : d.activeLayers), []);
    }
    // Effective visibility includes hidden parent groups. Do not traverse a
    // hidden group as a visible container, even if children have eye icons on.
    const shown = [];
    function visit(layers, parentsVisible) {
      for (const layer of layers) {
        const visible = parentsVisible && layer.visible === true;
        if (!visible) continue;
        shown.push(layer);
        if (groupLayer(layer)) visit(Array.from(layer.layers), visible);
      }
    }
    visit(Array.from(d.layers), true);
    return shown;
  }
  function unique(layers) {
    const ids = new Set();
    return layers.filter(layer => {
      if (ids.has(layer.id)) return false;
      ids.add(layer.id); return true;
    });
  }
  function selectedTexts() {
    return unique(Array.from(doc().activeLayers || []).filter(textLayer));
  }
  function sameIds(a, b) {
    const aa = Array.from(a).map(Number).sort((x,y)=>x-y);
    const bb = Array.from(b).map(Number).sort((x,y)=>x-y);
    return aa.length === bb.length && aa.every((v,i)=>v===bb[i]);
  }
  async function batch(command) {
    const result = await action.batchPlay([command], {});
    if (!result || !result[0]) throw Error("Photoshop 未返回结果");
    if (result[0]._obj === "error") throw Error(result[0].message || "Photoshop 操作失败");
    return result[0];
  }
  async function selectIds(ids) {
    if (!ids.length) throw Error("此范围内没有文字图层");
    await core.executeAsModal(async () => {
      for (let i = 0; i < ids.length; i++) {
        const cmd = {_obj:"select", _target:[{_ref:"layer",_id:ids[i]}],makeVisible:false};
        if (i) cmd.selectionModifier={_enum:"selectionModifierType",_value:"addToSelection"};
        await batch(cmd);
      }
    }, {commandName:"选中文字图层"});
    const selected = doc().activeLayers.map(l=>l.id);
    if (!sameIds(ids,selected)) throw Error("选中状态与目标不一致：目标 "+ids.length+" 个，实际 "+selected.length+" 个");
  }
  async function readDescriptor(id) {
    const raw = await batch({_obj:"get",_target:[{_ref:"layer",_id:id}]});
    let text = raw.textKey;
    if (!text || typeof text !== "object" || !Array.isArray(text.textStyleRange)) {
      const response = await batch({_obj:"get",_target:[{_property:"textKey"},{_ref:"layer",_id:id}]});
      text = response.textKey;
    }
    if (!text || typeof text.textKey !== "string" ||
        !Array.isArray(text.textStyleRange) || !text.textStyleRange.length ||
        !Array.isArray(text.paragraphStyleRange) || !text.paragraphStyleRange.length)
      throw Error("无法读取完整文字样式，已停止以防止破坏排版");
    return {raw,text};
  }
  function equal(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
  // Numeric-tolerant descriptor comparison, including Photoshop text transforms.
  function almostEqual(a,b,tolerance) {
    if (typeof a === "number" && typeof b === "number")
      return Math.abs(a-b) <= tolerance;
    if (a===b) return true;
    if (!a || !b || typeof a !== typeof b) return false;
    if (typeof a!=="object") return false;
    const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();
    return ak.length===bk.length && ak.every((key,i)=>
      key===bk[i] && almostEqual(a[key],b[key],tolerance));
  }
  function px(n) { return Number(n && typeof n === "object" && "value" in n ? n.value : n); }
  function warningsFor(job,actual) {
    const warnings=[];
    if ((job.after.textShape||[]).some(x=>x.textType && (x.textType._value==="box" || x.textType==="box")))
      warnings.push(job.name+"：段落文字框请确认是否溢出");
    const b=actual.raw.boundsNoEffects || actual.raw.bounds;
    if(b) {
      const width=px(doc().width), height=px(doc().height);
      if([px(b.left),px(b.top),px(b.right),px(b.bottom),width,height].every(Number.isFinite) &&
        (px(b.left)<-0.5 || px(b.top)<-0.5 || px(b.right)>width+0.5 || px(b.bottom)>height+0.5))
        warnings.push(job.name+"：文字可能超出画布");
    }
    return warnings;
  }
  function checkEditable(layer) {
    if (layer.locked === true || layer.allLocked === true)
      throw Error(layer.name+"：图层已锁定，请先解锁");
  }
  function styleAt(ranges,position,kind) {
    if (!Array.isArray(ranges) || !ranges.length) return null;
    const range=ranges.find(x=>x.from<=position && x.to>position) || ranges[0];
    return range && range[kind] || null;
  }
  const VISIBLE_STYLE_KEYS=[
    "fontPostScriptName","fontName","fontStyleName","size","impliedFontSize",
    "color","tracking","kerning","horizontalScale","verticalScale",
    "baselineShift","fauxBold","fauxItalic","underline","strikethrough",
    "capitalization","leading","autoLeading","ligature","baseline"
  ];
  function equivalentVisibleStyle(before,after) {
    if(!before || !after)return false;
    // Photoshop frequently inserts/removes implicit descriptor defaults.
    // Compare explicitly shared visual properties; don't reject a successful
    // text edit solely because Adobe normalized nonvisual metadata.
    for(const key of VISIBLE_STYLE_KEYS){
      if(Object.prototype.hasOwnProperty.call(before,key) &&
         Object.prototype.hasOwnProperty.call(after,key) &&
         !almostEqual(before[key],after[key],0.02)) return false;
    }
    return true;
  }
  function verifyDescriptor(job,actual) {
    if(actual.text.textKey !== job.newText)
      throw Error(job.name+"：文字内容未写入成功");
    const beforeStyles=job.before.textStyleRange || [];
    const afterStyles=actual.text.textStyleRange || [];
    const beforeParagraph=job.before.paragraphStyleRange || [];
    const afterParagraph=actual.text.paragraphStyleRange || [];
    if(!afterStyles.length || !afterParagraph.length)
      throw Error(job.name+"：Photoshop 未返回有效文字样式");
    // For complete replacement compare the source's first visible style.
    // For partial replacement, compare preserved style samples by output span.
    const newLength=job.newText.length;
    const samples=[0];
    for(const range of job.after.textStyleRange || [])samples.push(range.from);
    for(const p of samples){
      if(newLength && p>=newLength)continue;
      const expected=styleAt(job.after.textStyleRange,p,"textStyle");
      const observed=styleAt(afterStyles,p,"textStyle");
      if(!equivalentVisibleStyle(expected,observed))
        throw Error(job.name+"：替换后字体、大小或颜色发生变化");
    }
    const paraKeys=["align","justification","firstLineIndent","startIndent","endIndent",
      "spaceBefore","spaceAfter","hyphenate","direction"];
    for(const p of [0,...(job.after.paragraphStyleRange||[]).map(x=>x.from)]){
      if(newLength && p>=newLength)continue;
      const expected=styleAt(job.after.paragraphStyleRange,p,"paragraphStyle");
      const observed=styleAt(afterParagraph,p,"paragraphStyle");
      if(!expected||!observed)throw Error(job.name+"：段落样式读取失败");
      for(const key of paraKeys) {
        if(Object.prototype.hasOwnProperty.call(expected,key)&&
           Object.prototype.hasOwnProperty.call(observed,key)&&
           !almostEqual(expected[key],observed[key],0.02))
          throw Error(job.name+"：段落排版发生变化");
      }
    }
    if(!almostEqual(job.before.textShape,actual.text.textShape,0.02))
      throw Error(job.name+"：文字框形状或变换发生变化");
    if(!almostEqual(job.raw.layerEffects,actual.raw.layerEffects,0.02))
      throw Error(job.name+"：图层效果发生变化");
    if(actual.raw.name!==job.raw.name)
      throw Error(job.name+"：图层名称意外变化");
  }
  let previewPlan=null;
  function invalidatePreview() {
    previewPlan=null;
    $("tlmPreview").textContent="尚未检查";
    $("tlmRunFind").disabled=true;
  }
  function sourceEdits(old,find,replacement) {
    const finds=String(find).split(","), inserts=String(replacement).split(",");
    if(!finds.some(Boolean))throw Error("查找内容不能为空");
    if(finds.length!==inserts.length)throw Error("查找与替换组数不一致");
    // Preserve the source implementation's sequential comma-pair behavior.
    const units=old.split("").map((ch,origin)=>({ch,origin}));
    for(let i=0;i<finds.length;i++) {
      const needle=finds[i],insert=inserts[i];
      if(!needle)continue;
      const value=units.map(x=>x.ch).join("");
      const out=[];let cursor=0,at;
      while((at=value.indexOf(needle,cursor))!==-1) {
        out.push(...units.slice(cursor,at));
        out.push(...insert.split("").map(ch=>({ch,origin:null})));
        cursor=at+needle.length;
        if(out.length>30000)throw Error("文案超过30000字符");
      }
      out.push(...units.slice(cursor));
      if(out.length>30000)throw Error("文案超过30000字符");
      units.splice(0,units.length,...out);
    }
    const edits=[];let cursor=0,insert="";
    for(const item of units) {
      if(item.origin===null){insert+=item.ch;continue;}
      if(insert||item.origin>cursor)edits.push({start:cursor,end:item.origin,insert});
      insert="";cursor=item.origin+1;
    }
    if(insert||cursor<old.length)edits.push({start:cursor,end:old.length,insert});
    return edits;
  }
  async function prepareJobs(mode,find,replacement) {
    const d=doc(), layers=selectedTexts();
    if(!layers.length)throw Error("请先选中文字图层");
    if(mode==="all"&&!replacement.length)throw Error("请输入新的文字内容");
    if(mode==="find")sourceEdits("",find,replacement);
    const jobs=[];
    for(const layer of layers) {
      checkEditable(layer);
      const {raw,text}=await readDescriptor(layer.id);
      const edits=mode==="all"
        ?[{start:0,end:text.textKey.length,insert:replacement}]
        :sourceEdits(text.textKey,find,replacement);
      const change=planText(text,edits);
      if(change) jobs.push({id:layer.id,name:layer.name,raw,...change});
    }
    return {mode,fitMode:mode==="all"?fitMode:"keep",docId:d.id,selectionIds:layers.map(x=>x.id),jobs,find,replacement,skipped:layers.length-jobs.length};
  }
  function boundsWidth(raw) {
    const b=raw && (raw.boundsNoEffects || raw.bounds);
    if(!b)return NaN;
    const w=px(b.right)-px(b.left);
    return Number.isFinite(w)&&w>0?w:NaN;
  }
  function scaleUnit(value,factor) {
    if(typeof value==="number")return value*factor;
    if(value && typeof value==="object") {
      const obj=clone(value);
      if(Number.isFinite(obj._value))obj._value*=factor;
      else if(Number.isFinite(obj.value))obj.value*=factor;
      else return null;
      return obj;
    }
    return null;
  }
  function scaledTextDescriptor(base,factor) {
    const result=clone(base);
    let count=0;
    for(const range of result.textStyleRange || []) {
      const style=range.textStyle;
      if(!style)continue;
      if(style.size!==undefined) {
        const scaled=scaleUnit(style.size,factor);
        if(scaled!==null){style.size=scaled;count++;}
      }
      if(style.impliedFontSize!==undefined) {
        const scaled=scaleUnit(style.impliedFontSize,factor);
        if(scaled!==null)style.impliedFontSize=scaled;
      }
    }
    return count?result:null;
  }
  async function applyTextDescriptor(id,after) {
    await batch({_obj:"set",_target:[{_ref:"textLayer",_id:id}],
      to:{...clone(after),_obj:"textLayer"}});
  }
  async function restoreLayerName(job) {
    const written=await readDescriptor(job.id);
    if(written.raw.name!==job.raw.name) {
      await batch({_obj:"set",_target:[{_ref:"layer",_id:job.id}],
        to:{_obj:"layer",name:job.raw.name}});
    }
  }
  async function fitLongText(job,initial,context,warnings) {
    const originalWidth=boundsWidth(job.raw);
    if(!Number.isFinite(originalWidth)) {
      warnings.push(job.name+"：无法读取原始宽度，未自动缩小");
      return initial;
    }
    let result=initial;
    const baseDescriptor=clone(job.after);
    let ratio=1;
    const minRatio=0.5;
    for(let attempt=0;attempt<6;attempt++) {
      if(context.isCancelled)throw Error("用户取消操作");
      const width=boundsWidth(result.raw);
      if(!Number.isFinite(width)){
        warnings.push(job.name+"：无法测量修改后宽度");
        return result;
      }
      if(width<=originalWidth+0.5)return result;
      const nextRatio=Math.max(minRatio,ratio*Math.min(0.96,(originalWidth/width)*0.985));
      if(nextRatio>=ratio-0.0001)break;
      const next=scaledTextDescriptor(baseDescriptor,nextRatio);
      if(!next){
        warnings.push(job.name+"：字号描述不可编辑，未能自动缩小");
        return result;
      }
      job.after=next;
      await applyTextDescriptor(job.id,next);
      await restoreLayerName(job);
      result=await readDescriptor(job.id);
      ratio=nextRatio;
      if(ratio<=minRatio+0.0001)break;
    }
    if(boundsWidth(result.raw)>originalWidth+0.5)
      warnings.push(job.name+"：缩至原字号50%后仍超宽，请手动检查");
    return result;
  }
  async function runJobs(prepared) {
    if(doc().id!==prepared.docId ||
      !sameIds(prepared.selectionIds,selectedTexts().map(l=>l.id)))
      throw Error("文档或选中图层发生变化，请重新检查");
    if(!prepared.jobs.length)return {count:0,warnings:[]};
    const jobs=prepared.jobs;
    const warnings=[];
    // History suspension protects against partial edits: any failed check or
    // cancellation rolls back the entire batch instead of leaving half-edited PSD.
    await core.executeAsModal(async context=>{
      const hc=context.hostControl;
      const suspension=await hc.suspendHistory({documentID:prepared.docId,name:"批量文字管理"});
      let commit=false;
      try {
        for(const job of jobs) {
          if(context.isCancelled)throw Error("用户取消操作");
          const current=await readDescriptor(job.id);
          if(!almostEqual(current.text,job.before,0.001) ||
             !almostEqual(current.raw.layerEffects,job.raw.layerEffects,0.02))
            throw Error(job.name+"：内容或样式已发生变化，请重新检查");
        }
        for(let i=0;i<jobs.length;i++) {
          if(context.isCancelled)throw Error("用户取消操作");
          const job=jobs[i];
          await applyTextDescriptor(job.id,job.after);
          await restoreLayerName(job);
          let actual=await readDescriptor(job.id);
          if(prepared.mode==="all" && prepared.fitMode==="shrink") {
            actual=await fitLongText(job,actual,context,warnings);
          }
          verifyDescriptor(job,actual);
          warnings.push(...warningsFor(job,actual));
          if(context.reportProgress)
            context.reportProgress({value:(i+1)/jobs.length,commandName:"批量文字管理"});
        }
        commit=true;
      }finally {
        // On error or cancellation, explicitly rollback all written layers.
        await hc.resumeHistory(suspension,commit);
      }
    },{commandName:"批量文字管理"});
    return {count:jobs.length,warnings};
  }


  /* Same edit and style range mapping approach as the supplied find-replace-text.js */
  function applyEdits(old,edits) {
    let result="",cursor=0;
    for(const e of edits) {
      if(e.start<cursor||e.end<e.start||e.end>old.length) throw Error("文字编辑位置无效");
      result+=old.slice(cursor,e.start)+e.insert;
      cursor=e.end;
    }
    return result+old.slice(cursor);
  }
  function mapRanges(old,edits,ranges,kind,newLength) {
    if (!Array.isArray(ranges)||!ranges.length) return ranges;
    if (!ranges.every(x=>Number.isInteger(x.from)&&Number.isInteger(x.to)&&x.from<=x.to))
      throw Error("不支持的 Photoshop "+kind+" 样式区间");
    const max=old.length;
    if (ranges.some(x=>x.from<0||x.from>max+1||x.to>max+1)) throw Error("文字样式区间超出内容长度");
    const ordered=ranges.every((r,i)=>!i||r.from>=ranges[i-1].to);
    let rangeIndex=0;
    const covered=Array.from({length:Math.max(1,max)},(_,pos)=>{
      if (ordered) {
        while(rangeIndex<ranges.length&&ranges[rangeIndex].to<=pos&&ranges[rangeIndex].from!==pos)rangeIndex++;
        let index=rangeIndex;
        while(index<ranges.length&&ranges[index].from<=pos){
          if(ranges[index].to>pos)return index;
          index++;
        }
        return rangeIndex<ranges.length&&ranges[rangeIndex].from===pos?rangeIndex:-1;
      }
      const which=ranges.findIndex(r=>r.from<=pos&&r.to>pos);
      return which>=0?which:ranges.findIndex(r=>r.from===pos);
    });
    if(covered.some(i=>i<0))throw Error("文字样式存在无法映射的区间");
    const mapped=[];let cursor=0;
    for(const e of edits){
      while(cursor<e.start)mapped.push(covered[cursor++]);
      const sourceIndex=covered[Math.min(e.start,covered.length-1)];
      for(let n=0;n<e.insert.length;n++)mapped.push(sourceIndex);
      cursor=e.end;
    }
    while(cursor<max)mapped.push(covered[cursor++]);
    if(mapped.length!==newLength)throw Error("文字样式映射长度不一致");
    if(!mapped.length){const first=clone(ranges[0]);first.from=0;first.to=0;return [first];}
    const next=[];
    for(let i=0;i<mapped.length;i++){
      const s=ranges[mapped[i]];
      if(next.length&&equal(next[next.length-1][kind],s[kind]))next[next.length-1].to=i+1;
      else{const item=clone(s);item.from=i;item.to=i+1;next.push(item);}
    }
    if(ranges[ranges.length-1].to===max+1)next[next.length-1].to++;
    return next;
  }
  function planText(descriptor,edits) {
    const old=descriptor.textKey, newText=applyEdits(old,edits);
    if(newText===old)return null;
    if(newText.length>30000)throw Error("单个文字层超过30000字符");
    const after=clone(descriptor);after.textKey=newText;
    for(const [name,kind] of [["textStyleRange","textStyle"],["paragraphStyleRange","paragraphStyle"]])
      after[name]=mapRanges(old,edits,after[name],kind,newText.length);
    return {before:descriptor,after,old,newText};
  }
  async function guarded(task) {
    if(busy)return;
    busy=true;
    try {await task();}
    catch(error){console.error("[Text Layer Manager]",error);status(String(error&&error.message||error),"error");}
    finally {busy=false;}
  }
  $("tlmSelect").addEventListener("click",()=>guarded(async()=>{
    const scope=scopeValue;
    const targets=unique(layersInScope(scope).filter(textLayer));
    status("找到 "+targets.length+" 个文字图层，正在选中…");
    await selectIds(targets.map(l=>l.id));
    status("已核对：选中 "+targets.length+" 个文字图层","ok");
  }));
  $("tlmRefresh").addEventListener("click",()=>{

    try {
      const all=Array.from(doc().activeLayers||[]);
      const texts=all.filter(textLayer);
      status("当前选中 "+all.length+" 个图层，其中 "+texts.length+" 个文字图层","ok");
    }catch(e){status(e.message,"error");}
  });
  function renderResult(result) {
    const note=result.warnings.length
      ? "；提示："+result.warnings.slice(0,4).join("；")
      : "；文字及样式已校验";
    status("已处理 "+result.count+" 个文字图层"+note,"ok");
  }
  $("tlmApply").addEventListener("click",()=>guarded(async()=>{
    const value=$("tlmReplacement").value;
    status("正在检查选中文字图层…");
    const jobs=await prepareJobs("all","",value);
    renderResult(await runJobs(jobs));
  }));
  $("tlmAdvancedToggle").addEventListener("click",function(){
    const panel=$("tlmAdvancedPanel");
    const open=panel.style.display==="none";
    panel.style.display=open?"block":"none";
    this.setAttribute("aria-expanded",open?"true":"false");
  });
  $("tlmFind").addEventListener("input",invalidatePreview);
  $("tlmFindReplacement").addEventListener("input",invalidatePreview);
  $("tlmCheck").addEventListener("click",()=>guarded(async()=>{
    invalidatePreview();
    const find=$("tlmFind").value,replacement=$("tlmFindReplacement").value;
    const prepared=await prepareJobs("find",find,replacement);
    previewPlan=prepared;
    $("tlmPreview").textContent=prepared.jobs.length
      ?prepared.jobs.slice(0,30).map(j=>j.name+"："+
        j.old.slice(0,45)+" → "+j.newText.slice(0,45)).join("\n")
      :"没有匹配的文字";
    $("tlmRunFind").disabled=!prepared.jobs.length;
    status("检查完成：将修改 "+prepared.jobs.length+" 个文字图层，跳过 "+
      prepared.skipped+" 个","ok");
  }));
  $("tlmRunFind").addEventListener("click",()=>guarded(async()=>{
    if(!previewPlan)throw Error("请先检查预览");
    if(previewPlan.find!==$("tlmFind").value ||
      previewPlan.replacement!==$("tlmFindReplacement").value)
      throw Error("输入已变化，请重新检查");
    const prepared=previewPlan;
    invalidatePreview();
    renderResult(await runJobs(prepared));
  }));
  root.__textLayerManagerActivate=()=>{

    try{const selected=Array.from(doc().activeLayers||[]);
      status("当前选中 "+selected.length+" 个图层，其中 "+selected.filter(textLayer).length+" 个文字图层");
    }catch(e){status("请先打开 Photoshop 文档");}
  };
  root.__textLayerManagerActivate();
};
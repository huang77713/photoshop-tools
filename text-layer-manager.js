/* Text Layer Manager: selection and unified text replacement */
module.exports = function initTextLayerManager(root) {
  "use strict";
  const ps = require("photoshop");
  const {app, action, core, constants} = ps;
  const $ = id => root.querySelector("#" + id);
  let scopeValue = "selection";
  const pickerButton = $("tlmScopeButton");
  const pickerMenu = $("tlmScopeMenu");
  const pickerOptions = Array.from(root.querySelectorAll(".tlm-picker-option"));
  function closePicker() {
    pickerMenu.style.display = "none";
    pickerButton.setAttribute("aria-expanded", "false");
  }
  pickerButton.addEventListener("click", function () {
    const opening = pickerMenu.style.display === "none";
    pickerMenu.style.display = opening ? "block" : "none";
    pickerButton.setAttribute("aria-expanded", opening ? "true" : "false");
  });
  pickerOptions.forEach(option => {
    option.addEventListener("click", function () {
      scopeValue = option.getAttribute("data-scope");
      $("tlmScopeLabel").textContent = option.textContent;
      pickerOptions.forEach(item => item.classList.toggle("active", item === option));
      closePicker();
    });
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
    closePicker();
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
  $("tlmApply").addEventListener("click",()=>guarded(async()=>{
    const d=doc();
    const value=$("tlmReplacement").value;
    if(!value.length)throw Error("请输入新的文字内容");
    if(value.length>30000)throw Error("文字内容不能超过30000字符");
    const texts=selectedTexts();
    if(!texts.length)throw Error("请先选中文字图层，或使用上方的批量选择");
    const selectedIds=texts.map(l=>l.id);
    const jobs=[];
    status("正在读取 "+texts.length+" 个文字图层…");
    for(const layer of texts){
      const {text}=await readDescriptor(layer.id);
      // Replace all existing content, while remapping text and paragraph
      // style ranges to prevent destructive loss of the original formatting.
      const planned=planText(text,[{start:0,end:text.textKey.length,insert:value}]);
      if(planned)jobs.push({id:layer.id,name:layer.name,...planned});
    }
    if(!jobs.length){status("所有选中文字图层已经是该内容，无需修改","ok");return;}
    if(doc().id!==d.id||!sameIds(selectedIds,selectedTexts().map(l=>l.id)))
      throw Error("文档或选择发生变化，请重新操作");
    status("正在修改 "+jobs.length+" 个文字图层…");
    await core.executeAsModal(async()=>{
      // Verify before modifying inside the document transaction.
      for(const job of jobs){
        const current=await readDescriptor(job.id);
        if(!equal(current.text,job.before))
          throw Error(job.name+"：文字内容或样式已变化");
      }
      for(const job of jobs){
        await batch({_obj:"set",_target:[{_ref:"textLayer",_id:job.id}],
          to:{...clone(job.after),_obj:"textLayer"}});
      }
    },{commandName:"批量统一修改文字内容"});
    for(const job of jobs){
      const actual=await readDescriptor(job.id);
      if(actual.text.textKey!==value)
        throw Error(job.name+"：写入后的文字内容核对失败");
    }
    status("已将 "+jobs.length+" 个文字图层统一修改为："+value,"ok");
  }));
  root.__textLayerManagerActivate=()=>{

    try{const selected=Array.from(doc().activeLayers||[]);
      status("当前选中 "+selected.length+" 个图层，其中 "+selected.filter(textLayer).length+" 个文字图层");
    }catch(e){status("请先打开 Photoshop 文档");}
  };
  root.__textLayerManagerActivate();
};
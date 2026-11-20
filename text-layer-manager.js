/* Text Layer Manager: selection and style-preserving find/replace */
module.exports = function initTextLayerManager(root) {
  "use strict";
  const ps = require("photoshop");
  const {app, action, core, constants} = ps;
  const $ = id => root.querySelector("#" + id);
  let plan = null;
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
    return walk(Array.from(scope === "all" ? d.layers : d.activeLayers), []);
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
  function editsForFind(old,find,replacement) {
    const finds=String(find||"").split(",");
    const replacements=String(replacement??"").split(",");
    if (!finds.some(Boolean)) throw Error("查找内容不能为空");
    if (finds.length!==replacements.length) throw Error("查找与替换组数必须一致（逗号分隔）");
    const units=String(old).split("").map((ch,origin)=>({ch,origin}));
    for (let i=0;i<finds.length;i++) {
      const needle=finds[i], insert=replacements[i];
      if (!needle) continue;
      const value=units.map(x=>x.ch).join("");
      const out=[]; let cursor=0,at;
      while ((at=value.indexOf(needle,cursor))!==-1) {
        out.push(...units.slice(cursor,at));
        out.push(...insert.split("").map(ch=>({ch,origin:null})));
        cursor=at+needle.length;
        if (out.length>30000) throw Error("文案超过30000字符");
      }
      out.push(...units.slice(cursor));
      if(out.length>30000) throw Error("文案超过30000字符");
      units.splice(0,units.length,...out);
    }
    const edits=[];let cursor=0,insert="";
    for (const unit of units) {
      if(unit.origin===null){insert+=unit.ch;continue;}
      if(insert||unit.origin>cursor) edits.push({start:cursor,end:unit.origin,insert});
      insert="";cursor=unit.origin+1;
    }
    if(insert||cursor<old.length) edits.push({start:cursor,end:old.length,insert});
    return edits;
  }
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
  function clearPlan() {
    plan=null;
    $("tlmPreview").textContent="尚未检查";
    $("tlmApply").disabled=true;
  }
  async function guarded(task) {
    if(busy)return;
    busy=true;
    try {await task();}
    catch(error){console.error("[Text Layer Manager]",error);status(String(error&&error.message||error),"error");}
    finally {busy=false;}
  }
  $("tlmSelect").addEventListener("click",()=>guarded(async()=>{
    clearPlan();
    const scope=$("tlmScope").value;
    const targets=unique(layersInScope(scope).filter(textLayer));
    status("找到 "+targets.length+" 个文字图层，正在选中…");
    await selectIds(targets.map(l=>l.id));
    status("已核对：选中 "+targets.length+" 个文字图层","ok");
  }));
  $("tlmRefresh").addEventListener("click",()=>{
    clearPlan();
    try {
      const all=Array.from(doc().activeLayers||[]);
      const texts=all.filter(textLayer);
      status("当前选中 "+all.length+" 个图层，其中 "+texts.length+" 个文字图层","ok");
    }catch(e){status(e.message,"error");}
  });
  $("tlmCheck").addEventListener("click",()=>guarded(async()=>{
    clearPlan();
    const d=doc(), texts=selectedTexts();
    if(!texts.length)throw Error("请先在 Photoshop 中选中文字图层，或点击上方“选中文字图层”");
    const find=$("tlmFind").value, replacement=$("tlmReplacement").value;
    editsForFind("",find,replacement);
    const jobs=[];
    for(const layer of texts){
      const {raw,text}=await readDescriptor(layer.id);
      const planned=planText(text,editsForFind(text.textKey,find,replacement));
      if(planned)jobs.push({id:layer.id,name:layer.name,raw,...planned});
    }
    plan={docId:d.id,selectionIds:texts.map(l=>l.id),jobs,find,replacement};
    $("tlmPreview").textContent=jobs.length
      ?jobs.slice(0,24).map(j=>j.name+"\n"+j.old.slice(0,70)+"  →  "+j.newText.slice(0,70)).join("\n\n")
      :"当前文字图层无匹配内容";
    $("tlmApply").disabled=!jobs.length;
    status("检查完成：选中 "+texts.length+" 个文字图层，将修改 "+jobs.length+" 个","ok");
  }));
  $("tlmApply").addEventListener("click",()=>guarded(async()=>{
    if(!plan||!plan.jobs.length)throw Error("请先点击“检查预览”");
    const d=doc();
    if(d.id!==plan.docId)throw Error("文档已切换，请重新检查");
    if($("tlmFind").value!==plan.find||$("tlmReplacement").value!==plan.replacement)
      throw Error("输入内容已变化，请重新检查");
    if(!sameIds(plan.selectionIds,selectedTexts().map(l=>l.id)))
      throw Error("选择的文字图层已变化，请重新检查");
    // Re-read every descriptor before making changes.
    for(const job of plan.jobs){
      const current=await readDescriptor(job.id);
      if(!equal(current.text,job.before))throw Error(job.name+" 内容或样式已变化，请重新检查");
    }
    const jobs=plan.jobs;
    await core.executeAsModal(async()=>{
      for(const job of jobs){
        const descriptor={
          _obj:"set",_target:[{_ref:"textLayer",_id:job.id}],
          to:{...clone(job.after),_obj:"textLayer"}
        };
        await batch(descriptor);
      }
    },{commandName:"文字查找替换"});
    for(const job of jobs){
      const actual=await readDescriptor(job.id);
      if(actual.text.textKey!==job.newText)throw Error(job.name+"：写入后内容核对失败");
    }
    clearPlan();
    status("替换完成，并核对了 "+jobs.length+" 个文字图层","ok");
  }));
  $("tlmFind").addEventListener("input",clearPlan);
  $("tlmReplacement").addEventListener("input",clearPlan);
  root.__textLayerManagerActivate=()=>{
    clearPlan();
    try{const selected=Array.from(doc().activeLayers||[]);
      status("当前选中 "+selected.length+" 个图层，其中 "+selected.filter(textLayer).length+" 个文字图层");
    }catch(e){status("请先打开 Photoshop 文档");}
  };
  root.__textLayerManagerActivate();
};
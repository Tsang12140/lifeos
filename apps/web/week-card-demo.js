import {createPaintCache} from './week-card-paint-client.js';
const painter=createPaintCache();window.__paintStats=painter.stats;
const inputs = [...document.querySelectorAll('.tune-fields input[type="range"]')];
const preview = document.querySelector('.week-demo'), params = document.querySelector('#params'), status = document.querySelector('.tune-status');
const MY_PARAMETERS=Object.freeze({scope:'移动版周卡',font:'Huiwen Mincho SVG',weekdayDirection:'竖排',weekdayGlyphSizePx:20,dayGlyphSizePx:40,dayDigitGapPx:-13,datePadToTwoDigits:true,summaryFontSizePx:15,summaryFontKey:'huiwen',summaryFont:'汇文明朝体',summaryFontWeight:400,summarySyntheticBold:false,summaryColor:'#514D48',summaryColorName:'暖墨灰',photoWhiteVeilPercent:87,brushStrength:220,photoStyle:'印象派斑驳笔触',cardHeightPx:128,summaryMode:'每篇日记一行AI短摘要',summaryOverflow:'ellipsis',countPosition:'左下角',countFont:'汇文明朝体',countFontWeight:700,countSyntheticBold:true,countSeparator:false,lunarGlyphSizePx:40,lunarGapPx:33,lunarAlignment:'摘要可用区域内水平居中，卡片内容区Y轴居中'});
const MY_PRESET=Object.freeze({controls:Object.freeze({weekday:20,day:40,digitGap:-13,lunarX:0,summary:15,veil:87,brush:220,ink:'warm',face:'huiwen',bold:false}),visual:Object.freeze({lineHeight:28,rowGap:4,dateColor:'#172438',todayDateColor:'var(--primary)',countColor:'#67717c',borderColor:'var(--line)',todayBorderColor:'#b9c8fb'})});
const SUGGESTED_PRESET=Object.freeze({controls:Object.freeze({weekday:20,day:36,digitGap:-13,lunarX:-4,summary:15,veil:87,brush:220,ink:'warm',face:'huiwen',bold:false}),visual:Object.freeze({lineHeight:24,rowGap:4,dateColor:'#38352F',todayDateColor:'#38352F',countColor:'#807970',borderColor:'#D8D3CA',todayBorderColor:'#D8D3CA'})});
const variantNames={my:'我的参数',suggested:'建议版',custom:'自定义'};
const query = new URLSearchParams(location.search);
const ink=document.querySelector('#ink'),inkColors={warm:'#514D48',charcoal:'#40403D',blue:'#4D5869'};
const face=document.querySelector('#face'),bold=document.querySelector('#bold');
const fontFamilies={system:'inherit',serif:'"Week Demo Serif", serif',huiwen:'"Week Demo Huiwen", serif'};
const hasExplicitParams=['weekday','day','digitGap','lunarX','summary','veil','brush','ink','face','bold','lineHeight','rowGap','dateColor','todayDateColor','countColor','borderColor','todayBorderColor','wording'].some(key=>query.has(key));
let currentVariant=query.get('variant')==='suggested'?'suggested':query.get('variant')==='my'?'my':query.get('variant')==='custom'||hasExplicitParams?'custom':'my';
let summaryWording=currentVariant==='suggested'?'short':'original';
if(query.get('wording')==='short'||query.get('wording')==='original')summaryWording=query.get('wording');
let visual={...MY_PRESET.visual};
function setPresetValues(key){const preset=key==='suggested'?SUGGESTED_PRESET:MY_PRESET;for(const input of inputs)input.value=String(preset.controls[input.id]);ink.value=preset.controls.ink;face.value=preset.controls.face;bold.checked=preset.controls.bold;visual={...preset.visual};}
setPresetValues(currentVariant==='suggested'?'suggested':'my');
for (const input of inputs) {const value=query.get(input.id);if(value!==null&&Number.isFinite(Number(value)))input.value=String(Math.min(Number(input.max),Math.max(Number(input.min),Number(value))));}
if(Object.hasOwn(inkColors,query.get('ink')))ink.value=query.get('ink');
if(Object.hasOwn(fontFamilies,query.get('face')))face.value=query.get('face');
if(query.get('bold')==='1'||query.get('bold')==='0')bold.checked=query.get('bold')==='1';
const safeDemoColor=value=>/^#[\da-f]{6}$/i.test(value)||value==='var(--primary)'||value==='var(--line)';
for(const [key,param]of [['lineHeight','lineHeight'],['rowGap','rowGap']]){const value=query.get(key);if(value!==null&&Number.isFinite(Number(value)))visual[param]=Math.min(key==='lineHeight'?40:16,Math.max(key==='lineHeight'?16:0,Number(value)));}
for(const key of ['dateColor','todayDateColor','countColor','borderColor','todayBorderColor']){const value=query.get(key);if(value!==null&&safeDemoColor(value))visual[key]=value;}
const sources = [
  { source:'和朋友去城里的茶楼喝早茶，店里排了很久才轮到我们。', summary:'和朋友喝早茶，排队许久' },
  { source:'测试周期标记时发现，缺少开始日期，直接点结束会把整月都标上。', summary:'发现周期结束标记缺少起始校验' },
  { source:'给工作室做的AI外呼系统完成了演示视频，准备整理案例和界面放进作品集。', summary:'完成外呼系统演示视频，准备整理作品集与使用案例' },
];
// Synthetic demo assets: no owner screenshots or records are embedded.
const vectorUrl = source => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source);
const software = vectorUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400" viewBox="0 0 900 400"><rect width="900" height="400" fill="#263447"/><rect y="30" width="900" height="335" fill="#536174"/><rect x="110" y="50" width="760" height="280" fill="#f0f3f8"/><rect x="130" y="65" width="210" height="245" fill="#b5c5d6"/><g fill="#8799ae"><rect x="355" y="65" width="490" height="36"/><rect x="355" y="116" width="225" height="155"/><rect x="596" y="116" width="249" height="155"/><rect x="355" y="286" width="490" height="24"/></g><g fill="#b2c1d2"><rect x="12" y="63" width="76" height="18"/><rect x="12" y="101" width="76" height="18"/><rect x="12" y="139" width="76" height="18"/><rect x="12" y="177" width="76" height="18"/><rect x="12" y="215" width="76" height="18"/><rect x="12" y="253" width="76" height="18"/><rect x="12" y="291" width="76" height="18"/></g><g stroke="#314860" stroke-width="9"><path d="M369 143H562M369 168H540M369 194H562M369 220H525M609 143H829M609 168H800M609 194H829M609 220H789M130 380H800"/></g></svg>`);
const landscape = vectorUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="400"><rect width="900" height="400" fill="#9fbcd1"/><circle cx="700" cy="80" r="52" fill="#ead7ae"/><path d="M0 210L180 105 380 240 600 122 900 235V400H0Z" fill="#577c78"/><path d="M0 304L240 211 440 323 690 243 900 291V400H0Z" fill="#315a55"/><path d="M400 400Q400 270 900 300V400Z" fill="#648c9e"/></svg>`);
const cards = [
  {weekday:'周一',day:'2',items:sources,photo:software,today:true},
  {weekday:'周二',day:'3',items:sources},
  {weekday:'周三',day:'4',items:[],lunar:'廿六'},
  {weekday:'周四',day:'5',items:[{source:'晚饭后去河边散步，拍了傍晚的天空。',summary:'傍晚去河边散步，拍下落日'}],photo:landscape},
  {weekday:'周五',day:'6',items:[{source:'收拾房间，整理照片。',summary:'收拾房间，整理最近的照片'},{source:'晚上和家里人吃饭聊天。',summary:'和家人吃晚饭，聊了近况'}]},
  {weekday:'周六',day:'7',items:[],lunar:'廿九'},
  {weekday:'周日',day:'12',items:sources,photo:landscape},
];
function summaryForText(text){if(summaryWording!=='short')return text;if(text==='发现周期结束标记缺少起始校验')return '发现周期标记缺少起始校验';if(text==='完成外呼系统演示视频，准备整理作品集与使用案例')return '完成外呼系统演示视频';return text;}
const ns = 'http://www.w3.org/2000/svg';
function outline(char, url='/week-card-demo-glyphs.svg') {
  const svg = document.createElementNS(ns,'svg'), use = document.createElementNS(ns,'use');
  svg.classList.add('demo-outline'); svg.dataset.char = char; svg.setAttribute('viewBox','0 0 1000 1000'); svg.setAttribute('preserveAspectRatio','xMidYMid meet'); svg.setAttribute('aria-hidden','true');
  use.setAttribute('href',`${url}#calendar-lunar-u${char.codePointAt(0).toString(16).padStart(4,'0')}`); use.setAttribute('width','1000'); use.setAttribute('height','1000'); svg.append(use); return svg;
}
cards.forEach((data,index) => {
  const card = document.createElement('article'); card.className='demo-week-card'+(data.photo?' has-photo':'')+(data.today?' is-today':''); card.dataset.count=data.items.length;
  card.setAttribute('aria-label',`${data.weekday}，${Number(data.day)}日，${data.items.length}条记录`);
  if(data.photo) { const image=document.createElement('img');image.className='demo-photo';image.alt='';image.src=data.photo;image.dataset.source=data.photo;const veil=document.createElement('span');veil.className='demo-veil';card.append(image,veil); }
  else if(data.lunar) { const art=document.createElement('span');art.className='demo-empty-art';art.setAttribute('aria-hidden','true');card.append(art); }
  const head=document.createElement('span');head.className='demo-date';head.setAttribute('aria-hidden','true');
  const weekday=document.createElement('span');weekday.className='demo-weekday';for(const char of data.weekday)weekday.append(outline(char));
  const day=document.createElement('span');day.className='demo-day';const dayDigits=String(Number(data.day)).padStart(2,'0');for(const char of dayDigits)day.append(outline(char));head.append(weekday,day);card.append(head);
  if(data.items.length){const list=document.createElement('ul');list.className='demo-summaries';list.setAttribute('aria-label','逐篇摘要');data.items.forEach((item,i) => {const row=document.createElement('li');row.className='demo-summary';row.dataset.record=`sample-${index}-${i}`;row.dataset.originalSummary=item.summary;row.textContent=summaryForText(item.summary);row.title=row.textContent;list.append(row);});card.append(list);}
  else if(data.lunar){const glyphs=document.createElement('span');glyphs.className='demo-summaries demo-empty-lunar';glyphs.setAttribute('aria-hidden','true');for(const char of data.lunar)glyphs.append(outline(char,'/src/assets/calendar-lunar-glyphs.svg'));card.append(glyphs);}
  else{const list=document.createElement('ul');list.className='demo-summaries';list.setAttribute('aria-label','逐篇摘要');card.append(list);}
  if(data.items.length) {const count=document.createElement('span');count.className='demo-count';count.textContent=`${data.items.length} 条`;card.append(count);}
  preview.append(card);
});
function update() {
  const values=Object.fromEntries(inputs.map(input=>[input.id,Number(input.value)]));
  preview.style.setProperty('--weekday-size',values.weekday+'px');preview.style.setProperty('--day-size',values.day+'px');preview.style.setProperty('--day-digit-gap',values.digitGap+'px');preview.style.setProperty('--lunar-offset-x',values.lunarX+'px');preview.style.setProperty('--summary-size',values.summary+'px');preview.style.setProperty('--photo-veil',values.veil/100);
  preview.style.setProperty('--summary-ink',inkColors[ink.value]);
  preview.style.setProperty('--summary-font',fontFamilies[face.value]);preview.style.setProperty('--summary-weight',bold.checked?'700':'400');
  preview.style.setProperty('--summary-line-height',visual.lineHeight+'px');preview.style.setProperty('--summary-row-gap',visual.rowGap+'px');preview.style.setProperty('--demo-date-color',visual.dateColor);preview.style.setProperty('--demo-today-date-color',visual.todayDateColor);preview.style.setProperty('--demo-count-color',visual.countColor);preview.style.setProperty('--demo-border-color',visual.borderColor);preview.style.setProperty('--demo-today-border-color',visual.todayBorderColor);
  document.querySelectorAll('.demo-summary').forEach(row=>{row.textContent=summaryForText(row.dataset.originalSummary);row.title=row.textContent;});
  inputs.forEach(input=>document.getElementById(input.id+'-value').value=input.value+(['veil','brush'].includes(input.id)?'%':'px'));
  params.value=JSON.stringify({...MY_PARAMETERS,weekdayGlyphSizePx:values.weekday,dayGlyphSizePx:values.day,dayDigitGapPx:values.digitGap,lunarOffsetXPx:values.lunarX,summaryFontSizePx:values.summary,summaryFontKey:face.value,summaryFont:face.selectedOptions[0].textContent,summaryFontWeight:bold.checked?700:400,summarySyntheticBold:face.value==='huiwen'&&bold.checked,summaryColor:inkColors[ink.value],summaryColorName:ink.selectedOptions[0].textContent,photoWhiteVeilPercent:values.veil,brushStrength:values.brush,photoStyle:values.brush?'印象派斑驳笔触':'原图',summaryLineHeightPx:visual.lineHeight,summaryRowGapPx:visual.rowGap,dateColor:visual.dateColor,todayDateColor:visual.todayDateColor,countColor:visual.countColor,borderColor:visual.borderColor,todayBorderColor:visual.todayBorderColor,summaryWording:summaryWording==='short'?'每篇一个核心事件短标题':'原样例文案',variantKey:currentVariant,variantName:variantNames[currentVariant]},null,2);
  const url=new URL(location.href);for(const [key,value]of Object.entries(values))url.searchParams.set(key,value);for(const [key,value]of Object.entries({lineHeight:visual.lineHeight,rowGap:visual.rowGap,dateColor:visual.dateColor,todayDateColor:visual.todayDateColor,countColor:visual.countColor,borderColor:visual.borderColor,todayBorderColor:visual.todayBorderColor}))url.searchParams.set(key,value);url.searchParams.set('variant',currentVariant);url.searchParams.set('wording',summaryWording);url.searchParams.set('ink',ink.value);url.searchParams.set('face',face.value);url.searchParams.set('bold',bold.checked?'1':'0');history.replaceState(null,'',url);status.textContent='';
  document.querySelectorAll('[data-brush]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.brush)===values.brush)));
  document.querySelectorAll('[data-variant]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.variant===currentVariant)));
  document.querySelector('#variant-note').textContent=currentVariant==='suggested'?'建议版压缩第2、3条样例标题；切回“我的参数”会恢复原文和整套基准参数。':currentVariant==='my'?'我的参数已恢复；建议版的排版和短标题可随时切回。':'当前为自定义参数；选择任一预设可整体恢复对应版本。';
  schedulePaint();
}
function updateAsCustom(){currentVariant='custom';update();}
function applyPreset(key){currentVariant=key;summaryWording=key==='suggested'?'short':'original';setPresetValues(key);update();}
inputs.forEach(input=>input.addEventListener('input',updateAsCustom));
ink.addEventListener('change',updateAsCustom);
face.addEventListener('change',updateAsCustom);bold.addEventListener('change',updateAsCustom);
document.querySelectorAll('[data-variant]').forEach(button=>button.addEventListener('click',()=>applyPreset(button.dataset.variant)));
document.querySelector('#reset').addEventListener('click',()=>applyPreset('my'));
document.querySelector('#copy').addEventListener('click',async()=>{const buttons=[...document.querySelectorAll('.tune-actions button')];buttons.forEach(b=>b.disabled=true);try{await navigator.clipboard.writeText(params.value);status.textContent='已复制，粘贴发给我即可。';}catch{params.focus();params.select();status.textContent='请复制下方已选中的参数。';}finally{buttons.forEach(b=>b.disabled=false);}});
document.querySelector('#choose').addEventListener('click',()=>document.querySelector('#photo').click());
let objectUrl;
document.querySelector('#photo').addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;if(!file.type.startsWith('image/')){status.textContent='请选择图片文件。';return;}const next=URL.createObjectURL(file);const image=new Image();image.onload=()=>{const target=document.querySelector('.demo-photo');target.dataset.source=next;target.dataset.origin='local';target.src=next;if(objectUrl){painter.clearSource(objectUrl);URL.revokeObjectURL(objectUrl);}objectUrl=next;refreshComparison(next);schedulePaint(true);status.textContent='已更换第一张卡片的背景。';};image.onerror=()=>{URL.revokeObjectURL(next);status.textContent='图片未能读取，请换一张。';};image.src=next;});
addEventListener('pagehide',()=>{if(objectUrl)URL.revokeObjectURL(objectUrl);painter.close();});
const paintStatus=document.querySelector('.paint-status');
let ready=false,timer,revision=0,lastPaint='',comparisonSource='',comparisonRevision=0,sourceError='',comparisonError='';
function schedulePaint(force=false){
  if(!ready)return;const signature=[...document.querySelectorAll('.demo-photo')].map(i=>i.dataset.source).join('|')+'|'+document.querySelector('#brush').value;
  if(signature===lastPaint&&!force)return;lastPaint=signature;clearTimeout(timer);const current=++revision;
  timer=setTimeout(()=>renderCards(current),180);
}
async function renderCards(current){
  const strength=Number(document.querySelector('#brush').value);paintStatus.textContent='正在生成笔触…';
  try{
    for(const image of document.querySelectorAll('.demo-photo')){
      if(current!==revision)return;const source=image.dataset.source,value=await painter.get(source,strength);
      if(current!==revision)return;image.src=value.url;image.dataset.painted=String(strength);
    }
    if(current!==revision)return;
    paintStatus.textContent=sourceError||comparisonError||'笔触已就绪，滚动时直接显示缓存图片。';
    document.querySelector('.week-demo').dataset.paintReady=String(strength);
    painter.prune(new Set([...document.querySelectorAll('.demo-photo,.paint-comparison img')].map(i=>i.src)));
  }catch{if(current===revision){lastPaint='';paintStatus.textContent='笔触暂未生成，保留原图。请重试或更换图片。';}}
}
async function refreshComparison(source){
  if(source===comparisonSource)return;comparisonSource=source;comparisonError='';const current=++comparisonRevision;
  const grid=document.querySelector('.paint-comparison-grid');grid.replaceChildren();
  const entries=[[0,'原图'],[25,'轻笔触'],[55,'中笔触'],[85,'强笔触']];
  for(const[strength,label]of entries){const figure=document.createElement('figure'),image=document.createElement('img'),caption=document.createElement('figcaption');image.src=source;image.alt=label;image.dataset.comparison=String(strength);caption.textContent=label;figure.append(image,caption);grid.append(figure);}
  for(const[strength]of entries){
    try{if(current!==comparisonRevision)return;const value=await painter.get(source,strength);if(current!==comparisonRevision)return;grid.querySelector(`[data-comparison="${strength}"]`).src=value.url;}catch{if(current===comparisonRevision){comparisonError='部分笔触对比未生成，保留原图。';paintStatus.textContent=comparisonError;}}
  }
  painter.prune(new Set([...document.querySelectorAll('.demo-photo,.paint-comparison img')].map(i=>i.src)));
}
document.querySelectorAll('[data-brush]').forEach(button=>button.addEventListener('click',()=>{document.querySelector('#brush').value=button.dataset.brush;updateAsCustom();}));
async function loadExamplePhotos(){
  try{
    const [assetResponse,recordResponse]=await Promise.all([fetch('/api/assets',{credentials:'same-origin'}),fetch('/api/records?kind=journal',{credentials:'same-origin'})]);
    if(!assetResponse.ok||!recordResponse.ok)throw Error('auth');
    const [assets,records]=await Promise.all([assetResponse.json(),recordResponse.json()]);
    const eligible=new Set(records.items.filter(r=>r.kind==='journal'&&!r.isPrivate).flatMap(r=>(r.assetRefs||[]).map(ref=>ref.assetId)));
    const photos=assets.items.filter(a=>a.kind==='photo'&&eligible.has(a.id));
    if(!photos.length)throw Error('empty');
    const selected=[photos[0],photos[Math.floor(photos.length/2)],photos.at(-1)];
    const images=[...document.querySelectorAll('.demo-photo')];
    images.forEach((image,i)=>{if(image.dataset.origin==='local')return;const a=selected[i%selected.length],version=assets.thumbVersions?.[a.id],url=`/api/assets/${encodeURIComponent(a.id)}/thumbnail?w=400${a.displayRotation?'&r='+a.displayRotation:'&upright=1'}${version?'&v='+encodeURIComponent(version):''}`;image.dataset.source=url;image.dataset.origin='application';image.src=url;});
    await Promise.all(images.map(i=>i.decode()));
    document.querySelector('.week-demo').dataset.photoSource='application';
  }catch(error){sourceError=error.message==='auth'?'未能读取应用照片，请先登录应用再刷新；也可换本地图片。':'应用照片未能载入，暂用示意图；也可换本地图片。';}
  ready=true;refreshComparison(document.querySelector('.demo-photo').dataset.source);schedulePaint(true);
}
update();
loadExamplePhotos();

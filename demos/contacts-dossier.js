(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const platform = navigator.userAgentData?.platform || navigator.platform;
  const userAgent = navigator.userAgentData?.platform ? '' : navigator.userAgent;
  const systemFont = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  document.documentElement.style.setProperty('--lifeos-ui-font', /^Win/i.test(platform) || /Windows/i.test(userAgent) ? '"LifeOS MiSans", "MiSans", '+systemFont : systemFont);
  const icons = {
    person: '<circle cx="12" cy="8" r="3.3"/><path d="M5.3 21v-2.8a6.7 6.7 0 0 1 13.4 0V21"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    star: '<path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2-4.5-4.4 6.3-.9z"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4z"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.person}</svg>`;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  document.querySelectorAll('[data-icon]').forEach(e => { e.innerHTML = icon(e.dataset.icon); });

  // Original vector illustrations: no remote requests or real people's photographs.
  function portrait(kind) {
    const heads = {
      ming: `<rect width="160" height="160" fill="#dfcbb0"/><path d="M0 115 160 70v90H0" fill="#b7bfa5"/><path d="M21 160q5-47 57-47t61 47" fill="#4b685c"/><path d="m65 103-5 20 20 19 22-19-8-20" fill="#dcb08b"/><ellipse cx="80" cy="74" rx="34" ry="42" fill="#e9c09c"/><path d="M44 80q-8-41 14-55 29-18 51 2 17 15 8 49l-9-21q-19 5-37-12-4 17-24 20" fill="#3f4138"/><path d="M44 74q-9-10-9 2t13 17m67-19q10-8 9 4t-11 15" fill="#e9c09c"/><path d="M58 75h13m17 0h13" stroke="#574d3c" stroke-width="2" stroke-linecap="round"/><circle cx="66" cy="81" r="2" fill="#44483c"/><circle cx="94" cy="81" r="2" fill="#44483c"/><path d="m79 83-3 12 7 1m-15 8q12 7 24-1" stroke="#b7886b" stroke-width="1.7" fill="none" stroke-linecap="round"/><path d="m51 126 12 34m47-34-12 34" stroke="#78907d" stroke-width="2"/>`,
      li: `<rect width="160" height="160" fill="#e5d2c9"/><circle cx="127" cy="29" r="39" fill="#efdfd2"/><path d="M27 160q0-40 24-48l-7-53q-2-37 36-39 40 0 38 42l-9 54q24 8 26 44" fill="#4a403c"/><path d="M28 160q3-45 51-45t55 45" fill="#c39176"/><path d="m65 100-4 24q18 14 37 0l-5-24" fill="#e5b695"/><ellipse cx="80" cy="72" rx="30" ry="39" fill="#f0c8a6"/><path d="M49 71q-3-43 33-42 32 3 30 44l-12-24q-24 9-43-1z" fill="#4a403c"/><path d="M61 77h10m18 0h10" stroke="#78594a" stroke-width="1.5" stroke-linecap="round"/><circle cx="67" cy="81" r="1.8" fill="#544c40"/><circle cx="94" cy="81" r="1.8" fill="#544c40"/><path d="m80 85-2 10 6 1m-14 8q10 5 20-1" stroke="#c08c78" stroke-width="1.7" fill="none" stroke-linecap="round"/><circle cx="48" cy="91" r="3" fill="#d2b27d"/><circle cx="112" cy="91" r="3" fill="#d2b27d"/><path d="m58 124 22 20 23-21" stroke="#e1b59a" stroke-width="2" fill="none"/>`,
      xia: `<rect width="160" height="160" fill="#cbd9de"/><path d="M0 103q55-22 89 3t71-8v62H0" fill="#a9bdbd"/><path d="M22 160q4-45 57-45t59 45" fill="#53677c"/><path d="m64 99-5 25 21 16 21-17-6-24" fill="#d9ae8c"/><ellipse cx="80" cy="73" rx="31" ry="40" fill="#e8c29f"/><path d="M48 74q-14-37 9-50 32-16 52 5 13 14 6 47l-14-30q-9 10-27 9l-21 14" fill="#41474b"/><path d="M51 82h25m9 0h25m-34 0h9" stroke="#4d5b65" stroke-width="2"/><rect x="53" y="75" width="22" height="16" rx="6" fill="none" stroke="#4d5b65" stroke-width="1.7"/><rect x="86" y="75" width="22" height="16" rx="6" fill="none" stroke="#4d5b65" stroke-width="1.7"/><path d="m79 85-3 12 6 1m-13 8q11 5 21-1" stroke="#b58c72" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="m56 126 24 15 23-16m-23 16v19" stroke="#8196a7" stroke-width="2" fill="none"/>`,
      cat: `<rect width="160" height="160" fill="#e0d9bd"/><path d="M0 119q80-30 160 0v41H0" fill="#b9b99b"/><path d="m41 61 2-40 30 23q10-3 20 0l29-23-2 43q15 16 10 43-5 31-48 31-42-1-49-30-7-28 8-47" fill="#e9e4d2"/><path d="m47 36 2 29 15-15m48-14-20 15 19 14" fill="#cba99a"/><path d="m38 65 26-16 10 22-13 10-22-3m80-14-23-15-10 23 12 10 21-4" fill="#9b9b83"/><path d="m61 88 10 2m20 0 10-2" stroke="#5c6558" stroke-width="3" stroke-linecap="round"/><path d="m75 103 7 5 7-5z" fill="#bd9a89"/><path d="m82 108-1 8m-1 0q-8 8-14 0m14 0q8 8 15 0M57 104l-26-4m26 12-28 5m76-13 26-4m-26 12 28 5" stroke="#999e87" stroke-width="1.5" fill="none"/>`,
    };
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">${heads[kind]}</svg>`);
  }
  const people = [
    { id:'ming', name:'小明', alias:'陈明', image:portrait('ming'), common:true, star:true, relation:'大学同学', note:'会认真记住别人随口说过的话。散步时总想绕一点远路，说这样才像真的出了门。', recent:'沿着河边走了一大圈，小明说，下回带上相机。', date:'10月15日', count:28 },
    { id:'li', name:'阿梨', alias:'林梨', image:portrait('li'), common:true, star:true, relation:'朋友', note:'喜欢陶器，也喜欢收集那些不太实用、但拿在手里会开心的小东西。', recent:'阿梨带来一束小雏菊，花瓶刚好装得下。', date:'10月13日', count:19 },
    { id:'zhou', name:'老周', alias:'周予安', common:true, star:false, relation:'同事', note:'午休的咖啡搭子。', recent:'和老周讨论了新项目，终于有了一点头绪。', date:'10月12日', count:12 },
    { id:'xia', name:'林夏', alias:'小夏', image:portrait('xia'), common:false, star:false, relation:'朋友', note:'住在另一座城市。每次见面，还是能从上次没说完的地方继续聊下去。最近开始学做面包，寄来的照片里，厨房总是亮亮的。', recent:'收到了林夏的明信片，邮戳是上个月的。', date:'9月28日', count:8 },
    { id:'xu', name:'许知远', alias:'阿远', common:false, star:false, relation:'', note:'', recent:'', date:'', count:2 },
    { id:'tao', name:'桃子', alias:'陶知宜', image:portrait('cat'), common:false, star:false, relation:'朋友', note:'头像永远是她家的猫。本人倒是每次见面都换一个新发型。', recent:'桃子说，猫终于愿意睡进新买的窝了。', date:'9月16日', count:6 },
    { id:'an', name:'安安', alias:'宋安', common:false, star:false, relation:'邻居', note:'偶尔在楼下遇到，一起等那部总是很慢的电梯。', recent:'', date:'', count:3 },
    { id:'long', name:'陈一一（读书会）', alias:'一一', common:false, star:false, relation:'读书会', note:'推荐的书常常要放一阵子才读得进去，读完又觉得，确实是好书。', recent:'读书会聊到了最后一章，一一的笔记写得很密。', date:'8月30日', count:4 },
  ];
  let layout = 'grid', scope = 'all', mentions = 'linked', frame = 0, selectedFace = null, linkedFace = null, editingAvatar = null;
  let journal = '傍晚和小明去河边散步，路过那家还没打烊的面包店。\n\n给阿梨拍了橱窗里的小花瓶，她说下次一起去看看。老周的消息晚一点再回，今天想慢慢走。';
  const avatar = (p, extra='') => `<span class="avatar ${p.image ? '' : 'is-default'} ${extra}" data-avatar-kind="${p.image ? 'custom' : 'default'}">${p.image ? `<img src="${p.image}" alt="" decoding="async">` : icon('person')}</span>`;
  const common = p => p.common || p.star;
  const byName = (a,b) => a.name.localeCompare(b.name,'zh-CN');
  const searchMeasure=document.createElement('canvas').getContext('2d');
  function syncSearch(){
    const box=$('.demo-search-box'),mobile=innerWidth<=600||$('#preview').dataset.size==='phone';
    box.style.setProperty('--demo-search-sheet-width',Math.min(320,$('.directory').clientWidth)+'px');
    if(mobile){box.style.width='';return;}
    const s=getComputedStyle($('#search'));searchMeasure.font=s.font;
    const needed=searchMeasure.measureText($('#search').value).width+($('#search').value?88:60);
    box.style.width=(needed<=192?192:needed<=256?256:320)+'px';
  }
  function card(p) {
    const recent = p.recent ? `<button type="button" class="card-journal" data-journal="${p.id}" aria-label="预览与${escape(p.name)}关联的日记"><time>${escape(p.date)}</time><span class="card-journal-text">${escape(p.recent)}</span></button>` : '';
    return `<article class="person-card" data-person="${p.id}"><div class="card-head"><div class="card-avatar">${avatar(p)}<button type="button" class="avatar-edit" data-avatar-edit="${p.id}" aria-label="${p.image?'更换':'添加'}${escape(p.name)}的Demo头像">${icon('edit')}</button></div><div class="identity"><div class="name-line"><h3 class="person-name">${escape(p.name)}</h3><button type="button" class="star" data-star="${p.id}" aria-label="${p.star?'取消收藏':'收藏'}${escape(p.name)}" aria-pressed="${p.star}">${icon('star')}</button></div><p class="person-alias">${escape(p.alias)}</p></div></div>${p.note ? `<p class="card-summary">${escape(p.note)}</p>` : '<div class="card-summary is-quiet" aria-hidden="true"></div>'}${recent}<div class="card-bottom"><span class="card-relation">${escape(p.relation || '')}</span><button type="button" class="card-open" data-open="${p.id}" aria-label="查看${escape(p.name)}的小档案">小档案${icon('arrow')}</button></div></article>`;
  }
  function render() {
    const query = $('#search').value.trim().toLocaleLowerCase();
    let visible = people.filter(p => query ? [p.name,p.alias,p.relation].join(' ').toLocaleLowerCase().includes(query) : scope === 'all' || common(p));
    const groups = query ? [{ title:'搜索结果', key:'search', items:visible.sort(byName) }] : scope === 'common' ? [{ title:'常用联系人', key:'common', items:visible }] : [{ title:'常用联系人', key:'common', items:visible.filter(common) },{ title:'其他联系人', key:'other', items:visible.filter(p=>!common(p)).sort(byName) }];
    $('#contact-groups').innerHTML = groups.filter(g=>g.items.length).map(g=>`<section class="contact-section" data-group="${g.key}"><h2 class="group-heading">${g.title}<span>${g.items.length}</span></h2><div class="cards" data-layout="${layout}">${g.items.map(card).join('')}</div></section>`).join('');
    $('#directory-total').textContent = query ? `找到 ${visible.length} 位` : scope === 'all' ? `${people.length} 位联系人` : `${visible.length} 位常用联系人`;
    $('#directory-empty').hidden = visible.length > 0;
    $('#clear-search').hidden = !query;
    document.querySelectorAll('[data-scope]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.scope===scope)));
    document.querySelectorAll('.cards img').forEach(img=>img.addEventListener('load',schedule,{once:true}));
    observer.disconnect();observer.observe($('.directory'));
    document.querySelectorAll('.person-card').forEach(card=>observer.observe(card));
    schedule();
  }
  function measure() {
    syncSearch();
    document.querySelectorAll('.cards').forEach(grid => {
      const cards = [...grid.children];
      if (layout !== 'masonry') { grid.style.height=''; cards.forEach(c=>{c.style.width='';c.style.transform='';}); return; }
      const width=grid.clientWidth, gap=16;
      const phone=$('#preview').dataset.size==='phone'||innerWidth<=540;
      const columns=phone?1:Math.max(1,Math.floor((width+gap)/(235+gap)));
      const cardWidth=(width-gap*(columns-1))/columns;
      cards.forEach(c=>{c.style.width=cardWidth+'px';});
      const heights=cards.map(c=>c.getBoundingClientRect().height), bottoms=Array(columns).fill(0);
      cards.forEach((c,i)=>{const column=bottoms.indexOf(Math.min(...bottoms));c.style.transform=`translate(${column*(cardWidth+gap)}px,${bottoms[column]}px)`;bottoms[column]+=heights[i]+gap;});
      grid.style.height=Math.max(0,...bottoms)-gap+'px';
    });
  }
  function schedule(){cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);}
  function renderJournal() {
    const allNames=people.flatMap(p=>[p.name,p.alias]).sort((a,b)=>b.length-a.length);
    const pattern = new RegExp(allNames.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
    const pieces=[];let cursor=0;
    if(mentions==='linked') for(const match of journal.matchAll(pattern)) {
      pieces.push(escape(journal.slice(cursor,match.index)));
      const p=people.find(p=>p.name===match[0]||p.alias===match[0]);
      pieces.push(`<button type="button" class="person-mention" data-open="${p.id}">${p.image ? `<img class="mention-avatar" src="${p.image}" alt="" draggable="false">` : `<span class="mention-default">${icon('person')}</span>`}<span>${escape(match[0])}</span></button>`);
      cursor=match.index+match[0].length;
    }
    pieces.push(escape(journal.slice(cursor)));$('#journal-preview').innerHTML=pieces.join('');
    document.querySelectorAll('[data-mentions]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mentions===mentions)));
  }
  function openProfile(id) {
    const p=people.find(p=>p.id===id);if(!p)return;
    $('#profile-content').innerHTML=`<div class="profile-top">${avatar(p)}<div><h2 id="profile-name">${escape(p.name)}</h2><p>${escape([p.alias,p.relation].filter(Boolean).join(' / '))}</p></div></div>${p.note?`<p class="profile-description">${escape(p.note)}</p>`:''}${p.recent?`<section class="profile-records"><h3>关联日记</h3><p><time>${escape(p.date)}</time>${escape(p.recent)}</p></section>`:''}${linkedFace===p.id?`<section class="profile-records"><h3>已关联的照片</h3><div class="face-strip">${faceImages()}</div><p class="editor-note">这组三张示意照片已关联到${escape(p.name)}。</p></section>`:''}`;
    $('#profile-dialog').showModal();
  }
  function faceImages(){return [0,1,2].map(()=>`<span class="face-sample"><img src="${people[0].image}" alt="虚构人物照片示意"></span>`).join('');}
  function openRelatedJournal(id) {
    const p=people.find(p=>p.id===id);if(!p?.recent)return;
    const continuation={ming:'沿途的树开始掉叶子了。买了两只刚出炉的面包，一人拿一只，没等走到桥头就吃完了。',li:'把花放在桌上以后，整个房间都像亮了一点。我们坐着聊了很久，茶凉了又重新添上热水。',zhou:'之前纠结的几个地方，在纸上画出来就清楚多了。结束以后去楼下买咖啡，正好赶上雨停。',xia:'她写那边已经开始降温，要穿厚外套了。把明信片靠在书架上，准备周末给她写回信。',tao:'她发来一张猫窝的照片，小猫团得圆圆的，只露出一点耳朵。我们为这件小事认真高兴了一会儿。',long:'同一本书里，大家在意的地方完全不同。把那些没想过的角度记了下来，回去想再翻一遍。'};
    $('#related-journal-title').textContent='日记';
    $('#related-journal-meta').textContent=`${p.date} / 与${p.name}有关`;
    $('#related-journal-body').textContent=p.recent+'\n\n'+(continuation[p.id]||'');
    $('#related-journal-dialog').showModal();
  }
  function openFaces() {
    selectedFace=linkedFace;
    $('#face-choices').innerHTML=people.slice(0,4).map(p=>`<button type="button" class="face-choice" data-face-choice="${p.id}" aria-pressed="${p.id===selectedFace}">${avatar(p)}<span>${escape(p.name)}</span><small>${escape(p.alias)}</small></button>`).join('');
    $('#confirm-face').disabled=!selectedFace;$('#face-dialog').showModal();
  }
  document.addEventListener('click',e=>{
    const editAvatar=e.target.closest('[data-avatar-edit]');if(editAvatar){editingAvatar=editAvatar.dataset.avatarEdit;$('#demo-avatar-file').click();return;}
    const related=e.target.closest('[data-journal]');if(related){if(window.getSelection()?.isCollapsed!==false)openRelatedJournal(related.dataset.journal);return;}
    const star=e.target.closest('[data-star]');if(star){const p=people.find(p=>p.id===star.dataset.star);p.star=!p.star;render();const next=$(`[data-star="${p.id}"]`);next?.focus({preventScroll:true});return;}
    const open=e.target.closest('[data-open]');if(open){openProfile(open.dataset.open);return;}
    const close=e.target.closest('[data-close]');if(close){document.getElementById(close.dataset.close).close();return;}
    const choice=e.target.closest('[data-face-choice]');if(choice){selectedFace=choice.dataset.faceChoice;document.querySelectorAll('[data-face-choice]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.faceChoice===selectedFace)));$('#confirm-face').disabled=false;}
  });
  document.querySelectorAll('[data-layout]').forEach(b=>b.addEventListener('click',()=>{layout=b.dataset.layout;document.querySelectorAll('.demo-tools [data-layout]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.layout===layout)));$('#layout-caption').textContent=layout==='grid'?'姓名与头像保持对齐，适合快速找人。':'卡片随人物备注自然长短变化，头像与姓名规格保持一致。';render();}));
  document.querySelectorAll('[data-size]').forEach(b=>{if(b.tagName!=='BUTTON')return;b.addEventListener('click',()=>{$('#preview').dataset.size=b.dataset.size;document.querySelectorAll('button[data-size]').forEach(e=>e.setAttribute('aria-pressed',String(e.dataset.size===b.dataset.size)));schedule();});});
  document.querySelectorAll('[data-scope]').forEach(b=>b.addEventListener('click',()=>{scope=b.dataset.scope;render();}));
  document.querySelectorAll('[data-mentions]').forEach(b=>b.addEventListener('click',()=>{mentions=b.dataset.mentions;renderJournal();}));
  const searchBox=$('.demo-search-box');
  const closeSearch=()=>{searchBox.classList.remove('search-open');$('#toggle-demo-search').setAttribute('aria-expanded','false');};
  $('#toggle-demo-search').addEventListener('click',()=>{const open=searchBox.classList.toggle('search-open');$('#toggle-demo-search').setAttribute('aria-expanded',String(open));if(open)$('#search').focus();});
  $('#search').addEventListener('input',render);$('#search').addEventListener('keydown',e=>{if(e.isComposing)return;if(e.key==='Escape'||e.key==='Enter'){e.preventDefault();closeSearch();$('#search').blur();if(innerWidth<=600||$('#preview').dataset.size==='phone')$('#toggle-demo-search').focus();}});
  document.addEventListener('pointerdown',e=>{if(!searchBox.contains(e.target))closeSearch();});
  $('#clear-search').addEventListener('click',()=>{$('#search').value='';render();$('#search').focus();});
  $('#demo-avatar-file').addEventListener('change',e=>{const file=e.target.files?.[0],id=editingAvatar;e.target.value='';if(!file||!id||!file.type.startsWith('image/'))return;const reader=new FileReader();reader.addEventListener('load',()=>{const p=people.find(p=>p.id===id);if(p&&typeof reader.result==='string'){p.image=reader.result;render();renderJournal();}});reader.readAsDataURL(file);});
  $('#journal-input').value=journal;$('#journal-input').addEventListener('input',e=>{journal=e.target.value;renderJournal();});
  $('#edit-journal').addEventListener('click',()=>{const open=$('#journal-editor').hidden;$('#journal-editor').hidden=!open;$('#edit-journal').setAttribute('aria-expanded',String(open));$('#edit-journal').textContent=open?'收起':'改改文字';if(open)$('#journal-input').focus();});
  $('#face-strip').innerHTML=faceImages();$('#face-link').addEventListener('click',openFaces);
  $('#confirm-face').addEventListener('click',()=>{if(!selectedFace)return;linkedFace=selectedFace;const p=people.find(p=>p.id===linkedFace);$('#face-copy').innerHTML=`<span class="face-linked">${p.image?`<img src="${p.image}" alt="">`:''}已关联到${escape(p.name)}</span>`;$('#face-link').textContent='更改关联';$('#face-dialog').close();});
  document.querySelectorAll('dialog').forEach(dialog=>{
    let outside=false;
    dialog.addEventListener('pointerdown',e=>{const r=dialog.getBoundingClientRect();outside=e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);});
    dialog.addEventListener('click',e=>{const r=dialog.getBoundingClientRect();if(outside&&e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))dialog.close();outside=false;});
  });
  const observer=new ResizeObserver(schedule);observer.observe($('.directory'));window.addEventListener('resize',schedule);document.fonts.ready.then(schedule);
  render();renderJournal();
})();

// Memory-only interactions for frozen, fictional app snapshots.
const fixture = JSON.parse(document.querySelector('#fixture').textContent);
const root = document.querySelector('#root');
let currentView = 'journal', busy = false, aiOpen = false, photoOn = false;
const drafts = { journal: '', task: '', ai: '' };
const setting = { look: 'reference', base: 'light', input: true, toolbar: true, switch: true, ai: true, search: true };
let resizeFrame, toastTimer;
const $ = (s) => root.querySelector(s);
const $$ = (s) => [...root.querySelectorAll(s)];
const composerKind = () => $('.composer')?.classList.contains('composer-kind-task') ? 'task' : 'journal';
const announce = text => {
  const e = document.querySelector('#demo-notice'); e.textContent = text; e.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => e.hidden = true, 2600);
};
function remember() {
  const c = $('.composer-input'); if (c) drafts[composerKind()] = c.value;
  const a = $('.backfill-chat-composer textarea'); if (a) drafts.ai = a.value;
}
function fit() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const desktop = innerWidth > 900, grid = $('.content-grid'), rail = $('.context-rail'), panel = $('.ai-assistant-panel');
    rail?.classList.toggle('is-dock-layout', desktop);
    panel?.classList.toggle('is-docked', desktop);
    if (panel) { panel.classList.toggle('demo-mobile-open', !desktop && aiOpen); panel.setAttribute('aria-hidden', String(!desktop && !aiOpen)); }
    if (grid && rail && desktop) {
      const g = grid.getBoundingClientRect(), c = $('.content-column').getBoundingClientRect(), s = getComputedStyle(grid);
      const gap = parseFloat(s.columnGap) || 24, width = innerWidth <= 1160 ? 250 : 300;
      grid.style.setProperty('--context-left', (c.right + gap) + 'px');
      grid.style.setProperty('--context-width', width + 'px');
      grid.style.setProperty('--context-top', Math.max(24, g.top) + 'px');
      const task = $('.task-summary')?.getBoundingClientRect().height || 0;
      grid.style.setProperty('--assistant-height', Math.max(180, innerHeight - Math.max(24, g.top) - task - 48) + 'px');
    }
    parent.postMessage({ type: 'demo-status', view: currentView, width: innerWidth }, '*');
  });
}
function apply() {
  for (const [key,value] of Object.entries(setting)) document.documentElement.setAttribute('data-demo-' + key, String(value));
  fit();
}
function photo() {
  $$('.demo-photo').forEach(e => e.remove());
  const strip = $('.composer .shot-strip'); if (strip) strip.setAttribute('data-count', '0');
  if (!photoOn) return;
  const room = $('.composer .shot-strip') || $('.composer .composer-shots');
  if (room) {
    if (room.matches('.shot-strip')) room.setAttribute('data-count', '1');
    const e = document.createElement('span'); e.className = 'shot-tile demo-photo';
    const img = document.createElement('img'); img.src = fixture.photo; img.alt = '虚构风景示意图';
    e.append(img); room.prepend(e);
  }
}
function refreshInputs() {
  const c = $('.composer-input');
  if (c) { c.value = drafts[composerKind()]; c.style.height = 'auto'; c.style.height = Math.max(81, c.scrollHeight) + 'px'; }
  const a = $('.backfill-chat-composer textarea'); if (a) { a.value = drafts.ai; a.style.height = 'auto'; a.style.height = Math.min(120, Math.max(32, a.scrollHeight)) + 'px'; }
  $$('.composer-desktop-save,.composer-inline-save').forEach(e => e.disabled = busy || (!c?.value.trim() && !(photoOn && composerKind() === 'journal')));
  const send = $('.ai-send-button'); if (send) send.disabled = busy || !drafts.ai.trim();
  $$('.composer-input,.backfill-chat-composer textarea').forEach(e => e.disabled = busy);
}
function cleanSnapshot(container) {
  container.querySelectorAll('dialog, input[type=file]').forEach(e => e.remove());
  container.querySelectorAll('a').forEach(e => { e.removeAttribute('href'); e.removeAttribute('download'); });
}
function render(view) {
  remember(); currentView = view; busy = false;
  root.innerHTML = fixture.snapshots[view];
  // Remove captured, closed product dialogs; all demo actions stay local.
  cleanSnapshot(root);
  $$('.backfill-mode').forEach(e => e.remove());
  const intro = $('.backfill-intro'); if (intro) intro.textContent = '可以试写一段话，看看输入区是否顺手。';
  const head = $('.ai-assistant-header');
  if (head && !head.querySelector('.demo-ai-close')) {
    const b = document.createElement('button'); b.className = 'ai-header-icon demo-ai-close'; b.type = 'button'; b.setAttribute('aria-label','关闭 AI 管家'); b.textContent = '×'; head.append(b);
  }
  photo(); refreshInputs(); apply();
}
function switchKind(kind) {
  remember(); const current = $('.composer'); if (!current) return;
  if (composerKind() === kind || busy) return;
  const t = document.createElement('template'); t.innerHTML = fixture.snapshots[kind === 'task' ? 'journal-task' : 'journal'];
  const next = t.content.querySelector('.composer'), toolbar = current.querySelector('.composer-toolbar');
  cleanSnapshot(next);
  // Preserve the mounted switch buttons, so native transitions can start from
  // their current visible colors even when clicks reverse rapidly.
  current.className = next.className;
  [...current.children].filter(e => e !== toolbar).forEach(e => e.remove());
  [...next.children].filter(e => !e.classList.contains('composer-toolbar')).forEach(e => current.append(e));
  toolbar.querySelectorAll('.kind-option').forEach((b,i) => {
    const selected = (i === 1) === (kind === 'task');
    b.classList.toggle('is-active', selected); b.setAttribute('aria-selected', String(selected));
  });
  photo(); refreshInputs(); fit();
}
function switchEntities(view) {
  if (view === currentView) return;
  const heading = $('.entities-heading'), toolbar = $('.entities-library-toolbar');
  if (!heading || !toolbar) { render(view); return; }
  remember();
  const section = heading.parentElement, tabs = toolbar.querySelector('.entities-tabs');
  const t = document.createElement('template'); t.innerHTML = fixture.snapshots[view];
  const nextHeading = t.content.querySelector('.entities-heading'), next = nextHeading.parentElement;
  cleanSnapshot(next);
  heading.querySelector('.primary-button > span').textContent = nextHeading.querySelector('.primary-button > span').textContent;
  [...toolbar.children].filter(e => e !== tabs).forEach(e => e.remove());
  [...next.querySelector('.entities-library-toolbar').children].filter(e => !e.classList.contains('entities-tabs')).forEach(e => toolbar.append(e));
  [...section.children].filter(e => e !== heading && e !== toolbar).forEach(e => e.remove());
  [...next.children].filter(e => !e.classList.contains('entities-heading') && !e.classList.contains('entities-library-toolbar')).forEach(e => section.append(e));
  tabs.querySelectorAll('.entities-tab').forEach((b,i) => {
    const selected = (i === 1) === (view === 'places');
    b.classList.toggle('is-active', selected); b.setAttribute('aria-selected', String(selected));
  });
  currentView = view; fit();
  parent.postMessage({type: 'demo-view', view: currentView}, '*');
}
function localSave(ai = false) {
  if (busy) return;
  remember(); const text = ai ? drafts.ai.trim() : drafts[composerKind()].trim();
  if (!text && !photoOn) return;
  if (ai) {
    const area = $('.backfill-workspace-content');
    const message = document.createElement('p'); message.className = 'backfill-chat-copy demo-local-chat'; message.textContent = text;
    area?.append(message); drafts.ai = ''; refreshInputs(); announce('已添加到本页演示对话，未调用 AI'); return;
  }
  const template = $('.timeline-item');
  const list = $('.timeline-group') || $('.timeline-list');
  if (template && list) {
    const item = template.cloneNode(true); item.setAttribute('data-record-id','local-demo-' + Date.now());
    item.querySelector('.timeline-text').textContent = text;
    item.querySelectorAll('.record-photo-grid,.record-photos,.timeline-footer-places,.timeline-movie-cards,.weather-stamp,.record-delete-undo').forEach(e => e.remove());
    list.append(item);
  }
  drafts[composerKind()] = ''; photoOn = false; photo(); refreshInputs(); announce('已添加到本页演示列表，刷新即恢复');
}
function search(input) {
  const query = input.value.trim().toLowerCase();
  const cards = $$('.timeline-item,.entity-library-card');
  cards.forEach(e => e.hidden = Boolean(query && !e.textContent.toLowerCase().includes(query)));
  let empty = $('.demo-search-empty');
  if (!empty && cards.length) { empty = document.createElement('p'); empty.className = 'demo-search-empty'; empty.textContent = '没有匹配的演示内容'; cards[0].parentElement.append(empty); }
  if (empty) empty.hidden = !query || cards.some(e => !e.hidden);
  const bar = input.closest('.record-search');
  if (bar) bar.style.setProperty('--record-search-width', query.length > 6 ? '320px' : query ? '256px' : '192px');
}
root.addEventListener('input', e => {
  if (e.target.matches('.composer-input,.backfill-chat-composer textarea')) { remember(); refreshInputs(); fit(); }
  if (e.target.matches('.record-search-pill input')) search(e.target);
});
root.addEventListener('submit', e => { e.preventDefault(); if (e.target.matches('.backfill-chat-composer')) localSave(true); });
root.addEventListener('click', e => {
  const button = e.target.closest('button'); if (!button) return;
  const label = button.getAttribute('aria-label') || '', text = button.textContent.trim();
  if (button.closest('.kind-switcher')) { switchKind(text === '任务' ? 'task' : 'journal'); return; }
  if (button.matches('.composer-desktop-save,.composer-inline-save')) { localSave(); return; }
  if (button.matches('.ai-send-button')) return;
  if (button.matches('.demo-ai-close')) { aiOpen = false; fit(); return; }
  if (button.closest('.composer-shots')) { photoOn = !photoOn; photo(); refreshInputs(); announce(photoOn ? '已加入本地示意照片' : '已移除示意照片'); return; }
  if (button.matches('.record-search-mobile-trigger')) { button.closest('.record-search').classList.toggle('is-search-open'); return; }
  if (/清空/.test(label) && button.closest('.record-search')) { const input=button.closest('.record-search').querySelector('input'); if(input){input.value='';search(input);} return; }
  if (button.closest('.sidebar,.mobile-nav,.mobile-menu-nav')) {
    const views = { '日记':'journal', '任务':'tasks', '联系人':'people', '联系人与地点':'people', '日历':'calendar-month' };
    if (views[text]) { render(views[text]); parent.postMessage({type:'demo-view',view:currentView},'*'); }
    else announce('本副本演示日记、任务、联系人、地点和日历；其他入口沿用原外观');
    return;
  }
  if (button.matches('.entities-tab')) { switchEntities(text.startsWith('地点') ? 'places' : 'people'); return; }
  if (button.matches('.mode-option')) { render(text === '周' ? 'calendar-week' : 'calendar-month'); parent.postMessage({type:'demo-view',view:currentView},'*'); return; }
  if (/AI.*助手|AI.*管家/.test(label)) { aiOpen = !aiOpen; fit(); return; }
  if (button.closest('.record-search') && /筛选/.test(label)) { announce('这里只比较搜索框外观，可直接输入虚构记录中的关键词'); return; }
  if (button.closest('.composer') && /插入人物|插入地点/.test(label)) { const c=$('.composer-input'); c.value += label.includes('人物') ? '小禾' : '河岸书店'; c.dispatchEvent(new Event('input',{bubbles:true})); return; }
  announce('此入口保留原外观；Demo只演示本轮输入与控件效果');
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape') { aiOpen=false; $$('.record-search').forEach(x=>x.classList.remove('is-search-open')); fit(); }
});
addEventListener('message', e => {
  if(e.source !== parent || e.data?.type !== 'demo-control') return;
  const {action,value}=e.data;
  if(action === 'view') render(value);
  else if(action === 'sample') {
    remember(); photoOn = value === 'photo';
    drafts[composerKind()] = value === 'empty' ? '' : value === 'long' ? '今天想把步子放慢一点。'.repeat(30) : '傍晚去河岸书店，挑了一本书。回家的路上慢慢走了一会儿。';
    drafts.ai = value === 'empty' ? '' : '帮我找找最近和小禾去书店的记录。';
    photo(); refreshInputs(); fit();
  } else if(action === 'busy') { busy=value; refreshInputs(); }
  else if(action === 'aiOpen') { aiOpen=value; fit(); }
  else if(action === 'font') { document.documentElement.style.fontSize=value+'px'; fit(); }
  else if(Object.hasOwn(setting,action)) { setting[action]=value; apply(); }
});
addEventListener('resize',fit);
new ResizeObserver(fit).observe(root);
render('journal');
parent.postMessage({type:'demo-ready'},'*');

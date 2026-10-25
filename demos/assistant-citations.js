// Local fictional material only. No API, storage, uploads or model calls.
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const sources = {
  1: { kind: '日记', date: '2026年10月16日', title: '傍晚的河边', cited: 0, paragraphs: [
    '傍晚和小禾去河边散步。风有一点凉，走到桥边时天刚好暗下来。她说最近总是忙得顾不上吃饭，我们就顺着这句话，聊了好一会儿。',
    '回来的路上买了两杯热豆浆。走得不远，也没做什么特别的事，但回到家以后，人确实轻松了一点。',
    '本来还想把白天没做完的东西赶一赶，最后决定明天再说。洗好杯子，把手机放到书架上，坐着读了几页书。窗外有人推着自行车过去，铃铛只响了一声。',
    '临睡前想起小禾说的那句话：每天总得留一小段时间给自己。以前听着像道理，今天倒觉得，就是这样走一走也很好。',
    '下回想试试另一边的河堤。那里有一排树，夏天经过的时候满地都是影子。现在叶子应该少了，不过也许更适合看晚霞。' ] },
  2: { kind: '笔记', date: '2026年10月14日', title: '别把休息也排成任务', cited: 1, paragraphs: [
    '有时一闲下来就想找点事做，好像一定要完成什么，才算没有浪费这段时间。周末也能被排得满满当当。',
    '休息不一定要有成果。出去走一圈、发一会儿呆，或者什么也没做，都可以。别把休息也排成一张新的任务清单。',
    '想试试晚饭后不马上开电脑，留半个小时给自己。没有计划也可以，等到那时候再决定想做什么。' ] },
  3: { kind: '日记', date: '2026年10月12日', title: '在书店待了一个下午', cited: 0, paragraphs: [
    '下午去了河岸书店，没有想好要买什么。先翻了几本散文，后来在靠窗的位置坐下，一看就是一个多小时。',
    '走的时候只买了一本薄薄的小书。店员帮忙包好，纸袋很轻。外面天还亮着，索性绕远路回去，经过面包店买了明天的早饭。' ] },
};
const chatScroll = $('#chat-scroll'), input = $('#message-input'), preview = $('#source-preview');
const reader = $('#source-reader'), original = $('#original-record');
let scene = 'welcome', anchor = null, previewId = null, readingId = null;
let showTimer, hideTimer, toastTimer, savedScroll = 0, savedDocumentScroll = 0, savedFocus = null;
const phone = () => innerWidth <= 700 || $('#stage').dataset.device === 'phone';
const citation = id => `<button type="button" class="citation" data-source="${id}" aria-label="来源 ${id}：${sources[id].title}" aria-haspopup="dialog" aria-expanded="false">${id}</button>`;
const message = (role, text) => { const root = document.createElement('div'); root.className = `message ${role}`; const p = document.createElement('p'); p.textContent = text; root.append(p); return root; };
function notify(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3000); }
function closePreview() { clearTimeout(showTimer); clearTimeout(hideTimer); preview.hidden = true; if (anchor && !reader.open) anchor.setAttribute('aria-expanded', 'false'); previewId = null; }
function queueClose() { clearTimeout(showTimer); clearTimeout(hideTimer); hideTimer = setTimeout(closePreview, 200); }
function positionPreview() {
  if (preview.hidden || !anchor?.isConnected) return;
  const r = anchor.getBoundingClientRect(), p = preview.getBoundingClientRect(), margin = 12, gap = 8;
  let x = r.right + gap, y = r.top - p.height - gap;
  if (x + p.width > innerWidth - margin) x = r.left - p.width - gap;
  x = Math.max(margin, Math.min(x, innerWidth - p.width - margin));
  if (y < margin) y = r.bottom + gap;
  y = Math.max(margin, Math.min(y, innerHeight - p.height - margin));
  preview.style.left = `${x}px`; preview.style.top = `${y}px`;
  preview.dataset.horizontal = x >= r.right ? 'right' : 'left';
  preview.dataset.vertical = y + p.height <= r.top ? 'above' : 'below';
}
function showPreview(button) {
  if (phone() || reader.open || !button.isConnected) return;
  closePreview(); anchor = button; previewId = button.dataset.source;
  const source = sources[previewId];
  $('#preview-meta').textContent = `${source.date}　${source.kind}`;
  $('#preview-title').textContent = source.title;
  $('#preview-copy').textContent = source.paragraphs[source.cited];
  preview.setAttribute('aria-label', `阅读来源 ${previewId}：${source.title}的全文`);
  button.setAttribute('aria-expanded', 'true'); preview.hidden = false; positionPreview();
}
function paragraphs(target, source, highlight) {
  target.replaceChildren(); source.paragraphs.forEach((text, i) => {
    const p = document.createElement('p'); p.className = 'reader-paragraph'; p.textContent = text;
    if (highlight && i === source.cited) { p.classList.add('is-cited'); p.dataset.cited = 'true'; }
    target.append(p);
  });
}
function positionReader() {
  if (!reader.open) return;
  if (phone()) { reader.style.left = ''; reader.style.top = ''; return; }
  const a = $('#assistant').getBoundingClientRect(), width = reader.getBoundingClientRect().width;
  reader.style.left = `${Math.max(12, Math.min(a.right + 16, innerWidth - width - 12))}px`;
  reader.style.top = `${Math.max(12, Math.min(a.top, innerHeight - reader.getBoundingClientRect().height - 12))}px`;
}
function openReader(id, button = anchor) {
  const source = sources[id]; if (!source) return;
  closePreview(); anchor = button; readingId = id; savedFocus = button; savedScroll = chatScroll.scrollTop; savedDocumentScroll = scrollY;
  $$('.citation').forEach(b => b.setAttribute('aria-expanded', String(b === button)));
  $('#reader-heading').textContent = `来源 ${id}`;
  $('#reader-meta').textContent = `${source.date}　${source.kind}`; $('#reader-title').textContent = source.title;
  paragraphs($('#reader-copy'), source, true);
  if (!reader.open) { if (phone()) reader.showModal(); else reader.show(); }
  document.documentElement.style.overflow = 'hidden'; positionReader(); $('#close-reader').focus({ preventScroll: true });
  const cited = $('#reader-copy [data-cited]'), scroll = $('#reader-scroll');
  scroll.scrollTop = Math.max(0, cited.offsetTop - scroll.offsetTop - 26);
}
reader.addEventListener('close', () => {
  document.documentElement.style.overflow = ''; $$('.citation').forEach(b => b.setAttribute('aria-expanded', 'false'));
  chatScroll.scrollTop = savedScroll; window.scrollTo(0, savedDocumentScroll);
  if (savedFocus?.isConnected) savedFocus.focus({ preventScroll: true });
});
for (const dialog of [reader, original]) {
  dialog.addEventListener('cancel', event => { event.preventDefault(); event.stopPropagation(); dialog.close(); });
  let pressedOutside = false;
  const outside = e => { const r = dialog.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  dialog.addEventListener('pointerdown', e => { pressedOutside = outside(e); });
  dialog.addEventListener('click', e => { if (pressedOutside && outside(e)) dialog.close(); pressedOutside = false; });
}
$('#close-reader').addEventListener('click', () => reader.close()); $('#reader-back').addEventListener('click', () => reader.close());
$('#close-original').addEventListener('click', () => original.close());
$('#enter-record').addEventListener('click', () => {
  const source = sources[readingId], content = $('#original-copy'); content.replaceChildren();
  const meta = document.createElement('p'); meta.className = 'reader-meta'; meta.textContent = `${source.date}　${source.kind}（虚构示例）`;
  const title = document.createElement('h3'); title.textContent = source.title; const body = document.createElement('div'); paragraphs(body, source, false);
  content.append(meta, title, body); original.showModal(); $('#close-original').focus({ preventScroll: true });
});
preview.addEventListener('pointerenter', () => clearTimeout(hideTimer)); preview.addEventListener('pointerleave', queueClose);
preview.addEventListener('click', () => openReader(previewId));
function bindCitations() {
  $$('.citation').forEach(button => {
    button.addEventListener('pointerenter', e => { if (e.pointerType === 'touch' || phone()) return; clearTimeout(hideTimer); clearTimeout(showTimer); showTimer = setTimeout(() => showPreview(button), 110); });
    button.addEventListener('pointerleave', queueClose);
    button.addEventListener('focus', () => { if (button.matches(':focus-visible')) showPreview(button); });
    button.addEventListener('blur', () => { if (!preview.matches(':hover')) closePreview(); });
    button.addEventListener('click', () => openReader(button.dataset.source, button));
  });
}
function renderAnswer(question = '这周有没有什么让我放松下来的时刻？') {
  const root = $('#conversation'); root.replaceChildren(message('user', question));
  const answer = document.createElement('div'); answer.className = 'message assistant-message';
  // All markup is static and all source IDs belong to the local fictional fixture above.
  answer.innerHTML = `<p>有。周五傍晚，你和小禾沿着河边走了一段，回来买了热豆浆。你写的是“人确实轻松了一点”。${citation(1)}</p><p>周一在书店坐了一个下午，也没有安排什么非做不可的事。${citation(3)}</p><p>这些时刻倒是和你那条笔记对上了：休息不一定要有成果，别再给它排一张任务清单。${citation(2)}</p><p>这周可以继续留一点这样的空当。就像那晚，你把没做完的事留给了明天。${citation(1)}</p><div class="reply-tools"><button class="icon-button" type="button" aria-label="复制回答" data-note="此 Demo 仅演示引用阅读，未写入剪贴板。"><svg><use href="#copy"/></svg></button><button class="icon-button" type="button" aria-label="分享回答" data-note="此 Demo 仅演示引用阅读，未生成分享图片。"><svg><use href="#share"/></svg></button></div>`;
  root.append(answer); bindCitations();
}
function setScene(next) {
  closePreview(); if (original.open) original.close(); if (reader.open) reader.close(); scene = next;
  $('#welcome').hidden = next !== 'welcome'; $('#conversation').hidden = next === 'welcome';
  $$('[data-scene]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scene === next)));
  if (next === 'answer') renderAnswer(); chatScroll.scrollTop = 0;
}
$$('[data-scene]').forEach(b => b.addEventListener('click', () => setScene(b.dataset.scene)));
$$('[data-device]').filter(b => b.tagName === 'BUTTON').forEach(b => b.addEventListener('click', () => {
  $('#stage').dataset.device = b.dataset.device; $$('button[data-device]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); fit();
}));
$$('[data-reset]').forEach(b => b.addEventListener('click', () => setScene('welcome')));
$$('[data-prompt]').forEach(b => b.addEventListener('click', () => { input.value = b.dataset.prompt; input.dispatchEvent(new Event('input')); input.focus(); }));
input.addEventListener('input', () => { $('#send').disabled = !input.value.trim(); });
$('#composer').addEventListener('submit', e => {
  e.preventDefault(); const value = input.value.trim(); if (!value) return;
  setScene('answer'); renderAnswer(value); input.value = ''; input.dispatchEvent(new Event('input'));
  notify('已展示虚构回复，未调用 AI 或保存记录。');
});
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
document.addEventListener('click', e => { const b = e.target.closest('[data-note]'); if (b) notify(b.dataset.note); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || original.open) return;
  if (reader.open && !phone()) { e.preventDefault(); reader.close(); }
  else if (!reader.open) closePreview();
});
let downOutsideReader = false;
document.addEventListener('pointerdown', e => { downOutsideReader = reader.open && !reader.contains(e.target); }, true);
document.addEventListener('click', e => {
  if (!reader.open || phone() || original.open || reader.contains(e.target) || e.target.closest('.citation') || !downOutsideReader) return;
  reader.close(); e.preventDefault(); e.stopPropagation();
}, true);
chatScroll.addEventListener('scroll', closePreview, { passive: true });
addEventListener('scroll', closePreview, { passive: true });
function fit() {
  closePreview(); document.body.toggleAttribute('data-phone', phone());
  document.documentElement.style.setProperty('--demo-bar-height', `${$('.demo-bar').getBoundingClientRect().height}px`); positionReader();
}
addEventListener('resize', fit); new ResizeObserver(fit).observe($('.demo-bar'));
if (/^Win/i.test(navigator.userAgentData?.platform || navigator.platform)) document.documentElement.dataset.windows = '';
fit();
document.body.dataset.demoReady = 'true';

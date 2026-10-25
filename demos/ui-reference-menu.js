// The menu controls only the demo's two existing appearance variants.
const baseTrigger = document.querySelector('#base-trigger');
const baseMenu = document.querySelector('#base-menu');
const baseOutside = document.querySelector('#base-outside');
const baseOptions = [...baseMenu.querySelectorAll('[data-base]')];
let baseOpen = false;
function syncBaseSelection() {
  for (const b of baseOptions) {
    b.setAttribute('aria-checked', String(b.dataset.base === state.base));
    b.tabIndex = b.dataset.base === state.base ? 0 : -1;
  }
  document.querySelector('#base-label').textContent = state.base === 'tray' ? '浅灰底座' : '轻描边';
}
function positionBaseMenu() {
  if (!baseOpen) return;
  const view = window.visualViewport;
  const left = view?.offsetLeft || 0, top = view?.offsetTop || 0;
  const width = view?.width || innerWidth, height = view?.height || innerHeight;
  baseMenu.style.maxWidth = Math.max(0, width - 24) + 'px';
  baseMenu.style.maxHeight = Math.max(0, height - 24) + 'px';
  const trigger = baseTrigger.getBoundingClientRect(), menu = baseMenu.getBoundingClientRect();
  const spaceAbove = trigger.top - top - 12, spaceBelow = top + height - trigger.bottom - 12;
  const up = spaceAbove >= menu.height + 10 || spaceAbove >= spaceBelow;
  const available = Math.max(0, (up ? spaceAbove : spaceBelow) - 10);
  baseMenu.style.maxHeight = Math.min(height - 24, available) + 'px';
  const measured = baseMenu.getBoundingClientRect();
  baseMenu.style.left = Math.max(left + 12, Math.min(trigger.left, left + width - measured.width - 12)) + 'px';
  baseMenu.style.top = (up ? Math.max(top + 12, trigger.top - measured.height - 10) : Math.min(top + height - measured.height - 12, trigger.bottom + 10)) + 'px';
  baseMenu.dataset.direction = up ? 'up' : 'down';
}
function closeBaseMenu(restore = true) {
  if (!baseOpen) return;
  baseOpen = false;
  baseMenu.hidden = true;
  baseOutside.hidden = true;
  baseTrigger.setAttribute('aria-expanded', 'false');
  if (restore) baseTrigger.focus({preventScroll: true});
}
function openBaseMenu(edge) {
  if (baseTrigger.disabled) return;
  baseOpen = true;
  baseMenu.hidden = false;
  baseOutside.hidden = false;
  baseTrigger.setAttribute('aria-expanded', 'true');
  syncBaseSelection();
  positionBaseMenu();
  const target = edge === 'first' ? baseOptions[0] : edge === 'last' ? baseOptions.at(-1) : baseOptions.find(b => b.dataset.base === state.base);
  target.focus({preventScroll: true});
  target.scrollIntoView({block: 'nearest', inline: 'nearest'});
}
baseTrigger.addEventListener('click', () => baseOpen ? closeBaseMenu() : openBaseMenu());
baseTrigger.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openBaseMenu(e.key === 'ArrowDown' ? 'first' : 'last'); }
});
baseMenu.addEventListener('click', e => {
  const option = e.target.closest('[data-base]');
  if (!option) return;
  state.base = option.dataset.base;
  send('base', state.base);
  syncBaseSelection();
  closeBaseMenu();
});
baseMenu.addEventListener('keydown', e => {
  const at = Math.max(0, baseOptions.indexOf(document.activeElement));
  let next;
  if (e.key === 'ArrowDown') next = (at + 1) % baseOptions.length;
  if (e.key === 'ArrowUp') next = (at + baseOptions.length - 1) % baseOptions.length;
  if (e.key === 'Home') next = 0;
  if (e.key === 'End') next = baseOptions.length - 1;
  if (next !== undefined) { e.preventDefault(); baseOptions.forEach((b,i) => b.tabIndex = i === next ? 0 : -1); baseOptions[next].focus({preventScroll: true}); baseOptions[next].scrollIntoView({block: 'nearest', inline: 'nearest'}); }
  if (e.key === 'Tab') {
    closeBaseMenu();
  }
});
baseOutside.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
baseOutside.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); closeBaseMenu(); });
document.addEventListener('keydown', e => {
  if (baseOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBaseMenu(); }
});
addEventListener('resize', positionBaseMenu);
visualViewport?.addEventListener('resize', positionBaseMenu);
visualViewport?.addEventListener('scroll', positionBaseMenu);
document.addEventListener('scroll', e => {
  if (baseOpen && !baseMenu.contains(e.target)) closeBaseMenu();
}, true);
new ResizeObserver(positionBaseMenu).observe(baseMenu);
syncBaseSelection();

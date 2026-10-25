import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff } from 'lucide-react';
import { parsePrivacyAccess, privacyAccessKey, PRIVACY_DAY_MS, type PrivacyAccess } from './privacy-access';
import './privacy-access.css';
import { useApplicationLock } from './app-lock';

export function usePrivacyAccess(kind: 'display' | 'ai', scope: string, transient = false) {
  const key = privacyAccessKey(kind, scope) + (transient ? ':protected-memory' : '');
  const read = () => { if (transient) return null; try { return parsePrivacyAccess(localStorage.getItem(key)); } catch { return null; } };
  const [state, setState] = useState<{key: string; value: PrivacyAccess}>(() => ({ key, value: read() }));
  const value = state.key === key ? state.value : null;
  useEffect(() => {
    const refresh = () => setState({ key, value: read() });
    refresh();
    if (transient) return;
    window.addEventListener('storage', refresh); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [key]);
  useEffect(() => {
    if (typeof value !== 'number') return;
    const timer = window.setTimeout(() => setState({ key, value: null }), Math.max(0, value - Date.now()));
    return () => clearTimeout(timer);
  }, [key, value]);
  const change = (next: PrivacyAccess) => {
    try { if (!transient) { if (next === null) localStorage.removeItem(key); else localStorage.setItem(key, String(next)); } } catch { /* current tab still works */ }
    setState({ key, value: next });
  };
  return { key, value, active: value === 'always' || typeof value === 'number' && value > Date.now(), change };
}
export type PrivacyAccessState = ReturnType<typeof usePrivacyAccess>;

/** Keep the existing filter-only session choice across reloads, per account/card. */
export function usePrivacyViewSession(scope: string) {
  const key = privacyAccessKey('display', scope) + ':view-session';
  const read = () => { try { return sessionStorage.getItem(key) === '1'; } catch { return false; } };
  const [state, setState] = useState(() => ({ key, value: read() }));
  useEffect(() => { setState({ key, value: read() }); }, [key]);
  const change = (value: boolean) => { try { if (value) sessionStorage.setItem(key, '1'); else sessionStorage.removeItem(key); } catch { /* current tab remains usable */ } setState({ key, value }); };
  return [state.key === key && state.value, change] as const;
}

export function PrivacyAccessControl({ access, ai = false, disabled = false, onDisable }: { access: PrivacyAccessState; ai?: boolean; disabled?: boolean; onDisable?: () => void }) {
  const lock = useApplicationLock();
  const [open, setOpen] = useState(false), [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const anchor = useRef<HTMLDivElement>(null), bubble = useRef<HTMLDivElement>(null), status = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const label = ai ? '检索私密' : '显示私密';
  const enabled = access.active && !disabled && !lock?.locked(ai ? 'privacy-ai' : 'privacy-display');
  useEffect(() => { if (lock?.ready && lock.locked(ai ? 'privacy-ai' : 'privacy-display') && access.active) { access.change(null); onDisable?.(); } }, [lock?.ready, lock?.status.unlocked, lock?.status.targets, access.value, access.key]);
  const Icon = enabled ? Eye : EyeOff;
  useEffect(() => { if (!enabled) setOpen(false); }, [enabled]);
  useEffect(() => { setOpen(false); }, [access.key]);
  useEffect(() => {
    if (!open) return;
    // Keep one 12-second lifetime per opening, including when the mode changes.
    const timer = window.setTimeout(() => {
      if (bubble.current?.contains(document.activeElement)) status.current?.focus({ preventScroll: true });
      setOpen(false);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [open, access.key]);
  useLayoutEffect(() => {
    if (!open || !bubble.current || !anchor.current) return;
    const a = anchor.current.getBoundingClientRect(), b = bubble.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(innerWidth - b.width - 8, a.left)), top: a.top - b.height - 8 >= 8 ? a.top - b.height - 8 : Math.min(innerHeight - b.height - 8, a.bottom + 8) });
  }, [open, access.value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!bubble.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); status.current?.focus(); } };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); window.addEventListener('resize', close); document.addEventListener('scroll', close, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', close); document.removeEventListener('scroll', close, true); };
  }, [open]);
  return <div ref={anchor} className={'privacy-access-control' + (ai ? ' is-ai' : '')} data-privacy-kind={ai ? 'ai' : 'display'}>
    <div className="privacy-access-hit-area">
      <button type="button" role="switch" disabled={disabled || !!lock && !lock.ready} aria-checked={enabled} aria-label={label} title={disabled ? '更新服务后可用' : ai ? '允许 AI 检索私密记录' : label} className="privacy-access-switch" onClick={() => { if (enabled) { access.change(null); onDisable?.(); setOpen(false); } else { const enable = () => { access.change(Date.now() + PRIVACY_DAY_MS); setOpen(true); }; if (lock) lock.guard([ai ? 'privacy-ai' : 'privacy-display'], enable); else enable(); } }}>
        {!ai ? <Icon className="privacy-access-icon" size={18} strokeWidth={1.8} aria-hidden="true" /> : null}
        <span className="privacy-access-label">{ai ? <><span className="privacy-access-prefix">检索</span>私密</> : label}</span>
        <span className="privacy-switch-track" aria-hidden="true"><span className={'privacy-switch-duration' + (enabled && access.value === 'always' ? ' is-always' : '')}>{enabled ? access.value === 'always' ? '∞' : '24H' : null}</span><span className="privacy-switch-thumb" /></span>
      </button>
      <button ref={status} type="button" className="privacy-access-duration" disabled={!enabled} aria-hidden={!enabled} tabIndex={!enabled ? -1 : undefined} aria-label={`${label}的开启时长`} aria-haspopup="dialog" aria-controls={popoverId} aria-expanded={open} onClick={() => setOpen(!open)} />
    </div>
    {open && enabled ? createPortal(<div id={popoverId} ref={bubble} className="privacy-access-popover" role="dialog" aria-label={`${label}的开启时长`} style={position}>
      <p className="privacy-access-hint">{access.value === 'always' ? '将保持打开，直到手动关闭' : '24小时内将保持打开'}</p>
      <label className="privacy-access-always"><input type="checkbox" checked={access.value === 'always'} onChange={(event) => access.change(event.target.checked ? 'always' : Date.now() + PRIVACY_DAY_MS)} /><span>长期开启</span></label>
    </div>, document.body) : null}
  </div>;
}

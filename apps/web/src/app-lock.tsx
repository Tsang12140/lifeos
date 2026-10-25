import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { LockKeyhole, Eye, EyeOff, X } from 'lucide-react';
import { APP_LOCK_IDLE_MS, APP_LOCK_TARGETS, appLockPasswordValid, type AppLockStatus, type AppLockTarget } from '@lifeos/core';
import { apiRequest as api } from './api';
import { appUnlockToken, configureAppUnlock, setAppUnlockToken } from './app-lock-session';
import './app-lock.css';
import { scopedKey } from './storage-scope';
import { PinField } from './app-lock-pin';
const EMPTY: AppLockStatus = { configured: false, targets: [], idleMs: APP_LOCK_IDLE_MS, unlocked: false };
export function useAppLock(scope: string, enabled: boolean) {
  const [state, setState] = useState<{ scope: string; value: AppLockStatus; ready: boolean }>({ scope, value: EMPTY, ready: false });
  const [failure, setFailure] = useState('');
  const [prompt, setPrompt] = useState<{ targets: readonly AppLockTarget[]; requiresPassword: boolean; resolve: (value: boolean) => void } | null>(null);
  const pending = useRef(prompt), last = useRef(0), lastSent = useRef(0), generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null), reads = useRef(0);
  pending.current = prompt;
  const current = state.scope === scope ? state.value : EMPTY;
  const ready = state.scope === scope && state.ready;
  const read = async () => {
    const epoch = generation.current, request = ++reads.current;
    try { const value = await api<AppLockStatus>('/api/app-lock'); if (generation.current === epoch && reads.current === request) { if (!value.unlocked) setAppUnlockToken(undefined); setState({ scope, value, ready: true }); setFailure(''); } }
    catch { if (generation.current === epoch && reads.current === request) setFailure('应用锁状态读取失败，请重试'); }
  };
  useEffect(() => {
    generation.current++; setAppUnlockToken(undefined); setState({ scope, value: EMPTY, ready: false });
    pending.current?.resolve(false); setPrompt(null);
    if (enabled) void read();
    return () => { generation.current++; setAppUnlockToken(undefined); pending.current?.resolve(false); };
  }, [scope, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => { if (!document.hidden) void read(); };
    const updated = () => { generation.current++; pending.current?.resolve(false); pending.current = null; setPrompt(null); setAppUnlockToken(undefined); setState(s => ({ ...s, ready: false, value: { ...s.value, unlocked: false } })); void read(); };
    const bus = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(scopedKey('lifeos.app-lock:' + scope));
    channel.current = bus; if (bus) bus.onmessage = updated;
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { bus?.close(); channel.current = null; window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [scope, enabled]);
  const locked = (target: string) => !ready || current.targets.includes(target as AppLockTarget) && !current.unlocked;
  const ensure = (targets: readonly AppLockTarget[], consent = false): Promise<boolean> => {
    if (!ready) return Promise.resolve(false);
    const requiresPassword = targets.some(locked);
    if (!requiresPassword && !consent) return Promise.resolve(true);
    if (pending.current) return Promise.resolve(false);
    return new Promise(resolve => { const p = { targets, requiresPassword, resolve }; pending.current = p; setPrompt(p); });
  };
  const guard = (targets: readonly AppLockTarget[], action: () => void) => { if (!targets.some(locked)) action(); else void ensure(targets).then(ok => { if (ok) action(); }); };
  const finish = (value: boolean) => { pending.current?.resolve(value); pending.current = null; setPrompt(null); };
  const relock = () => { reads.current++; setAppUnlockToken(undefined); setState(s => ({ ...s, value: { ...s.value, unlocked: false } })); };
  const lock = async () => { const request = api('/api/app-lock/lock', { method: 'POST', body: '{}' }); relock(); try { await request; } catch { /* Local access is already closed even offline. */ } };
  useEffect(() => { configureAppUnlock(targets => ensure(targets, targets.includes('privacy-ai'))); return () => configureAppUnlock(undefined); });
  useEffect(() => {
    if (!current.unlocked) return;
    let trailing: number | undefined;
    const ping = () => { const proof = appUnlockToken(); lastSent.current = Date.now(); void api('/api/app-lock/activity', { method: 'POST', body: '{}' }).catch(() => { if (proof === appUnlockToken()) relock(); }); };
    const activity = (event: Event) => {
      if (!event.isTrusted || document.hidden) return;
      const now = Date.now();
      if (now - last.current >= APP_LOCK_IDLE_MS) { void lock(); return; }
      last.current = now;
      clearTimeout(trailing); trailing = window.setTimeout(() => { if (Date.now() - lastSent.current > 1000) ping(); }, 500);
      if (now - lastSent.current >= 20_000) {
        ping();
      }
    };
    const check = () => { if (Date.now() - last.current >= APP_LOCK_IDLE_MS) void lock(); };
    const timer = window.setInterval(check, 1000);
    for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) window.addEventListener(name, activity, { passive: true });
    document.addEventListener('visibilitychange', check); window.addEventListener('focus', check);
    return () => { clearTimeout(trailing); clearInterval(timer); for (const name of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) window.removeEventListener(name, activity); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, [current.unlocked, scope]);
  const submit = async (password: string) => {
    if (pending.current && !pending.current.requiresPassword) { finish(true); return; }
    const epoch = generation.current;
    const value = await api<AppLockStatus & { token: string }>('/api/app-lock/unlock', { method: 'POST', body: JSON.stringify({ password }) });
    if (epoch !== generation.current) return;
    reads.current++; setAppUnlockToken(value.token); last.current = Date.now(); lastSent.current = Date.now();
    setState({ scope, value, ready: true }); finish(true);
  };
  return { status: current, ready, failure, read, locked, ensure, guard, lock, prompt, finish, submit, announce: () => channel.current?.postMessage('configuration') };
}
export type AppLockController = ReturnType<typeof useAppLock>;
const LockContext = createContext<AppLockController | null>(null);
export const useApplicationLock = () => useContext(LockContext);
export function AppLockProvider({ controller, children }: { controller: AppLockController; children: ReactNode }) {
  return <LockContext.Provider value={controller}>{children}{controller.prompt ? <UnlockDialog controller={controller} /> : null}</LockContext.Provider>;
}
function LegacyPasswordField({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const [visible, setVisible] = useState(false);
  return <label className="app-lock-password"><span className="visually-hidden">原应用锁密码</span><input aria-label="原应用锁密码" autoComplete="off" type={visible ? 'text' : 'password'} value={value} maxLength={16} disabled={disabled} onChange={e => onChange(e.target.value)} /><button type="button" disabled={disabled} aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(v => !v)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></label>;
}
function UnlockDialog({ controller }: { controller: AppLockController }) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef(document.activeElement), input = useRef<HTMLInputElement>(null), closeButton = useRef<HTMLButtonElement>(null), pending = useRef(false);
  const keyboardTrigger = useRef(document.activeElement instanceof HTMLElement && document.activeElement.matches(':focus-visible'));
  const submitting = useRef(false);
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useLayoutEffect(() => {
    const modal = dialog.current;
    modal?.showModal();
    // showModal runs native initial focus after React's autofocus on the hidden input.
    input.current?.focus({ preventScroll: true });
    return () => {
      modal?.close();
      const source = trigger.current;
      if (!(source instanceof HTMLElement) || !source.isConnected) return;
      if (!submitting.current || keyboardTrigger.current) source.focus({ preventScroll: true });
      // Native close can also restore focus. Numeric typing must not turn a pointer
      // trigger into a keyboard-focused switch once verification succeeds.
      else if (document.activeElement === source) source.blur();
    };
  }, []);
  const targets = controller.prompt?.targets ?? [];
  const names = targets.filter(id => id !== 'privacy-ai').map(id => APP_LOCK_TARGETS.find(t => t.id === id)?.label).filter(Boolean).join('、');
  const requiresPassword = !!controller.prompt?.requiresPassword;
  const title = targets.includes('privacy-ai') ? `${requiresPassword && names ? '解锁' + names + '并' : ''}允许AI检索私密` : `解锁${names}`;
  const close = () => { if (!pending.current) controller.finish(false); };
  const submit = async (pin: string) => {
    if (pending.current || requiresPassword && !appLockPasswordValid(pin)) return;
    pending.current = true; submitting.current = true; setBusy(true); setError('');
    try { await controller.submit(pin); }
    catch (e) { pending.current = false; submitting.current = false; setPassword(''); setError(e instanceof Error ? e.message : '解锁失败'); setBusy(false); requestAnimationFrame(() => input.current?.focus()); }
  };
  return <dialog className={`app-lock-dialog${requiresPassword ? ' app-lock-pin-dialog' : ''}`} ref={dialog} aria-labelledby="app-unlock-title" aria-busy={busy} onCancel={e => { e.preventDefault(); close(); }} onClick={e => {
    if (requiresPassword && !pending.current && e.target instanceof Element && !e.target.closest('button,input')) input.current?.focus({ preventScroll: true });
  }} onKeyDown={e => {
    if (requiresPassword && e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); if (!pending.current) (document.activeElement === input.current ? closeButton.current : input.current)?.focus(); }
    if (requiresPassword && !pending.current && e.target !== input.current && !e.ctrlKey && !e.metaKey && !e.altKey && (/^[0-9]$/.test(e.key) || e.key === 'Backspace')) {
      e.preventDefault();
      const next = e.key === 'Backspace' ? password.slice(0, -1) : (password + e.key).slice(0, 4);
      setPassword(next); setError(''); input.current?.focus({ preventScroll: true });
      if (appLockPasswordValid(next)) void submit(next);
    }
  }}>
    <form onSubmit={e => { e.preventDefault(); if (!requiresPassword) void submit(''); }}>
      <div className="app-lock-dialog-heading"><h2 id="app-unlock-title">{title}</h2>{requiresPassword ? <button ref={closeButton} className="app-lock-close" type="button" aria-label="关闭解锁" disabled={busy} onClick={close}><X size={17} /></button> : null}</div>
      {requiresPassword ? <>
        <PinField autoFocus inputRef={input} label="应用锁密码" value={password} disabled={busy} invalid={!!error} onChange={value => { setPassword(value); setError(''); }} onComplete={pin => void submit(pin)} />
        <p className="app-lock-feedback" role={error ? 'alert' : 'status'}>{error || (busy ? '正在验证…' : '')}</p>
        {controller.status.legacyPassword ? <p className="app-lock-help">旧密码不是四位数字时，请到设置中更新。</p> : null}
      </> : <>
        <p className="app-lock-help">允许AI检索私密记录，24小时后关闭。</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="app-lock-actions"><button className="secondary-button" type="button" disabled={busy} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '处理中…' : '允许检索'}</button></div>
      </>}
    </form>
  </dialog>;
}
export function AppLockSettings() {
  const lock = useApplicationLock();
  const [targets, setTargets] = useState<readonly AppLockTarget[]>([]), [password, setPassword] = useState(''), [next, setNext] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const confirmInput = useRef<HTMLInputElement>(null);
  const targetSignature = lock?.status.targets.join(',') ?? '';
  useEffect(() => { setTargets(lock?.status.targets ?? []); }, [targetSignature]);
  if (!lock) return null;
  const configured = lock.status.configured;
  const legacy = lock.status.legacyPassword === true;
  const save = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return; setMessage('');
    if (configured && (legacy ? !password || password.length > 16 : !appLockPasswordValid(password))) { setMessage(legacy ? '请输入原应用锁密码' : '请输入4位数字的当前密码'); return; }
    const candidate = configured && !next ? password : next;
    if (!appLockPasswordValid(candidate)) { setMessage('密码必须是4位数字'); return; }
    if ((!configured || next) && next !== confirm) { setMessage('两次输入的密码不一致'); return; }
    setBusy(true);
    try { await api('/api/app-lock/config', { method: 'PUT', body: JSON.stringify({ password: configured ? password : next, ...(next ? { newPassword: next } : {}), targets }) }); setPassword(''); setNext(''); setConfirm(''); lock.announce(); await lock.read(); setMessage('应用锁设置已保存'); }
    catch (e) { setMessage(e instanceof Error ? e.message : '保存失败'); } finally { setBusy(false); }
  };
  return <section className="settings-card app-lock-settings">
    <div className="settings-card-icon"><LockKeyhole size={18} /></div><div className="settings-card-copy"><strong>应用锁</strong><small>共用一个密码，闲置10分钟后上锁。</small></div>
    {!lock.ready ? <div><p role="alert">{lock.failure || '正在读取应用锁…'}</p>{lock.failure ? <button type="button" className="secondary-button" onClick={() => void lock.read()}>重试</button> : null}</div> : <form onSubmit={e => void save(e)}>
      <fieldset disabled={busy}><legend>需要密码保护的项目</legend><div className="app-lock-targets">{APP_LOCK_TARGETS.map(t => <label key={t.id}><input type="checkbox" checked={targets.includes(t.id)} onChange={e => setTargets(current => e.target.checked ? [...current, t.id] : current.filter(id => id !== t.id))} /><span>{t.label}</span></label>)}</div></fieldset>
      <div className="app-lock-fields">
        {configured ? <div><span>{legacy ? '原密码' : '当前密码'}</span>{legacy ? <LegacyPasswordField disabled={busy} value={password} onChange={setPassword} /> : <PinField label="当前应用锁密码" value={password} disabled={busy} onChange={setPassword} />}</div> : null}
        <div><span>{configured ? '新密码（留空则不更改）' : '设置密码'}</span><PinField label="新应用锁密码" value={next} disabled={busy} onChange={value => { setNext(value); setConfirm(''); setMessage(''); }} onComplete={() => requestAnimationFrame(() => confirmInput.current?.focus())} /></div>
        {!configured || next ? <div><span>确认密码</span><PinField inputRef={confirmInput} label="确认应用锁密码" value={confirm} disabled={busy} invalid={confirm.length === 4 && next !== confirm} onChange={value => { setConfirm(value); setMessage(''); }} /></div> : null}
      </div>
      <p className="app-lock-help">密码为4位数字，可使用0开头。{legacy ? '请验证原密码后更新为四位数字。' : ''}</p>
      {message ? <p role="status">{message}</p> : null}
      <div className="app-lock-actions">{configured && lock.status.unlocked ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void lock.lock()}>立即上锁</button> : null}<button className="primary-button" disabled={busy} type="submit">{busy ? '保存中…' : configured ? '保存设置' : '设置应用锁'}</button></div>
    </form>}
  </section>;
}

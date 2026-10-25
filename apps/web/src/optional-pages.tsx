import { useEffect, useRef, useState } from "react";
import { Check, Plus } from "lucide-react";
import { DreamIcon } from "./dream-icon";
import { apiRequest } from "./api";
import { useActionMenu } from "./action-menu";
import "./optional-pages.css";

/** A server preference follows the account; hiding an entry never deletes content. */
export function useDreamPagePreference(scope: string | null) {
  const [state, setState] = useState<{ scope: string | null; enabled: boolean | null; busy: boolean; error: string | null }>({ scope: null, enabled: null, busy: false, error: null });
  const current = useRef(scope); current.current = scope;
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ scope, enabled: null, busy: false, error: null });
    if (scope) apiRequest<{ enabled: boolean }>("/api/pages/dreams", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setState({ scope, enabled: value.enabled, busy: false, error: null }); })
      .catch(() => { if (!controller.signal.aborted) setState({ scope, enabled: null, busy: false, error: "页面列表读取失败" }); });
    return () => controller.abort();
  }, [scope, retry]);
  const change = async (enabled: boolean) => {
    if (!scope || state.scope !== scope || state.enabled === null || state.busy) return false;
    setState(previous => ({ ...previous, busy: true, error: null }));
    try {
      const value = await apiRequest<{ enabled: boolean }>("/api/pages/dreams", { method: "PUT", body: JSON.stringify({ enabled }) });
      if (current.current !== scope) return false;
      setState({ scope, enabled: value.enabled, busy: false, error: null }); return true;
    } catch {
      if (current.current === scope) setState(previous => ({ ...previous, busy: false, error: "保存失败，请重试" }));
      return false;
    }
  };
  return { ...(state.scope === scope ? state : { enabled: null, busy: false, error: null }), change, retry: () => setRetry(value => value + 1) };
}

export interface PagePickerProps {
  enabled: boolean | null;
  busy: boolean;
  error: string | null;
  onChange: (enabled: boolean) => Promise<boolean>;
  onRetry: () => void;
}

export function PagePicker({ enabled, busy, error, onChange, onRetry }: PagePickerProps) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useActionMenu(menu, open, () => setOpen(false));
  return <div className="optional-page-picker">
    <button type="button" className="nav-item optional-page-add" onClick={() => setOpen(value => !value)} aria-haspopup="menu" aria-expanded={open}><Plus size={18} strokeWidth={1.8} aria-hidden="true" /><span>新增页面</span></button>
    {open ? <div className="optional-page-menu action-menu" ref={menu} role="menu" aria-label="可选页面">
      <button type="button" role="menuitemcheckbox" aria-checked={enabled === true} disabled={busy || enabled === null} onClick={async () => { if (await onChange(!enabled)) setOpen(false); }}><DreamIcon size={16} /><span>梦境</span>{enabled ? <Check size={16} aria-hidden="true" /> : null}</button>
      {error ? <><p role="alert">{error}</p>{enabled === null ? <button type="button" role="menuitem" onClick={onRetry}>重新读取</button> : null}</> : null}
      {!error && enabled === null ? <p role="status">正在读取…</p> : null}
    </div> : null}
  </div>;
}

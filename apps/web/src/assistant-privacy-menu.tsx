import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useApplicationLock } from "./app-lock";
import { PRIVACY_DAY_MS } from "./privacy-access";
import type { PrivacyAccessState } from "./privacy-access-control";

/**
 * AI 私密检索的两行菜单项（2026-10-23 主人要求从顶栏开关搬进右键菜单）。
 * 管家有两份右键菜单：对话区／顶栏一份（assistant-backfill），单条消息一份
 * （assistant-message-info）；正文上右键走的是后者，所以两处都得挂，逻辑只写一份。
 * 勾选样式而非开关：左边一颗始终可见的小方框，勾上才出现勾。
 */
export function AssistantPrivacyMenuItems({ access, disabled = false, onBeforeUnlock }: { readonly access: PrivacyAccessState; readonly disabled?: boolean; readonly onBeforeUnlock?: () => void }) {
  const lock = useApplicationLock();
  const enabled = access.active && !disabled && !(lock && lock.locked("privacy-ai"));
  const toggle = () => {
    if (enabled) { access.change(null); return; }
    // 需要密码时先收起菜单，别让浮层悬在解锁浮层后面。
    if (lock && lock.locked("privacy-ai")) onBeforeUnlock?.();
    const enable = () => access.change(Date.now() + PRIVACY_DAY_MS);
    if (lock) lock.guard(["privacy-ai"], enable); else enable();
  };
  const toggleAlways = () => access.change(access.value === "always" ? Date.now() + PRIVACY_DAY_MS : "always");
  return <>
    <button type="button" role="menuitemcheckbox" aria-checked={enabled} disabled={disabled} title={disabled ? "更新服务后可用" : "允许 AI 检索私密记录"} onClick={toggle}><span className={`ai-assistant-menu-check${enabled ? " is-checked" : ""}`} aria-hidden="true">{enabled ? <Check size={11} strokeWidth={3.2} /> : null}</span><span className="ai-assistant-menu-label">检索私密</span></button>
    {enabled ? <button type="button" role="menuitemcheckbox" aria-checked={access.value === "always"} onClick={toggleAlways}><span className={`ai-assistant-menu-check${access.value === "always" ? " is-checked" : ""}`} aria-hidden="true">{access.value === "always" ? <Check size={11} strokeWidth={3.2} /> : null}</span><span className="ai-assistant-menu-label">长期开启</span></button> : null}
  </>;
}

/**
 * 标题栏右侧的状态提示（2026-10-23 主人选定方案 A）。
 * 只在「检索私密」真正生效时出现；它是状态不是按钮，点击不做任何事，关闭仍走右键菜单。
 * 时长按小时取整（开启时即 24H），精确到期时刻放 title 里；到期由 usePrivacyAccess
 * 的定时器把状态置空，这里不用自己维护倒计时。
 */
export function AssistantPrivacyStatus({ access, disabled = false }: { readonly access: PrivacyAccessState; readonly disabled?: boolean }) {
  const lock = useApplicationLock();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (typeof access.value !== "number") return;
    let timer: number;
    const refresh = () => {
      const current = Date.now();
      setNow(current);
      const remaining = access.value as number - current;
      if (remaining > 0) {
        const untilNextHour = remaining % 3_600_000 || 3_600_000;
        timer = window.setTimeout(refresh, Math.min(untilNextHour + 20, remaining));
      }
    };
    refresh();
    const onReturn = () => { window.clearTimeout(timer); refresh(); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => { window.clearTimeout(timer); window.removeEventListener("focus", onReturn); document.removeEventListener("visibilitychange", onReturn); };
  }, [access.value]);
  if (!(access.active && !disabled && !(lock && lock.locked("privacy-ai")))) return null;
  const always = access.value === "always";
  const hours = typeof access.value === "number" ? Math.max(1, Math.ceil((access.value - now) / 3_600_000)) : null;
  const until = typeof access.value === "number" ? new Date(access.value).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <span className={`ai-assistant-status${always ? " is-always" : ""}`} title={always ? "检索私密已长期开启，右键菜单里可关闭" : `检索私密开启中，${until} 结束，右键菜单里可关闭`} aria-label={always ? "检索私密长期开启" : `检索私密剩余 ${hours} 小时`}>
      <svg className="ai-assistant-status-lock" viewBox="265 200 495 625" aria-hidden="true"><path d="M352 448v-99.2C352 278.4 409.6 224 480 224s128 54.4 128 124.8c0 19.2-12.8 32-32 32s-32-12.8-32-32c0-35.2-28.8-60.8-64-60.8s-64 25.6-64 60.8V448h288c19.2 0 32 12.8 32 32v224c0 54.4-41.6 96-96 96h-256c-54.4 0-96-41.6-96-96v-224c0-19.2 12.8-32 32-32h32z m0 64v192c0 19.2 12.8 32 32 32h256c19.2 0 32-12.8 32-32v-192H352z m160 64c19.2 0 32 12.8 32 32v32c0 19.2-12.8 32-32 32s-32-12.8-32-32v-32c0-19.2 12.8-32 32-32z" fill="currentColor" /></svg>
      <span className="ai-assistant-status-text">{always ? "长期" : `${hours}H`}</span>
    </span>
  );
}

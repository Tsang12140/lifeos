import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Settings, MoreHorizontal, Plus, NotebookPen, ListChecks, type LucideIcon } from "lucide-react";
import { DreamIcon } from "./dream-icon";
import type { AppView } from "./app-types";
import { MOBILE_MORE_ITEMS, MOBILE_NAV_ITEMS, NAV_ITEMS, SETTINGS_NAV_ITEM } from "./app-meta";

export function Sidebar({ activeView, onNavigate, dreamsEnabled, pagePicker, privacyControl }: { activeView: AppView; onNavigate: (view: AppView) => void; dreamsEnabled: boolean; pagePicker: ReactNode; privacyControl: ReactNode }) {
  return (
    <aside className="sidebar" aria-label="LifeOS 导航">
      <div className="brand-lockup"><img className="brand-mark" src="/favicon.svg?v=3" alt="" /><span className="brand-name">LifeOS</span></div>
      <nav className="primary-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return <button className={`nav-item ${activeView === item.id ? "is-active" : ""}`} data-view={item.id} key={item.id} type="button" onClick={() => onNavigate(item.id)} aria-current={activeView === item.id ? "page" : undefined}><Icon size={18} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span></button>;
        })}
        {dreamsEnabled ? <button type="button" className={`nav-item ${activeView === "dreams" ? "is-active" : ""}`} onClick={() => onNavigate("dreams")} aria-current={activeView === "dreams" ? "page" : undefined}><DreamIcon size={18} /><span>梦境</span></button> : null}
        {pagePicker}
      </nav>
      <div className="sidebar-footer">{privacyControl}<button className={`nav-item sidebar-settings-item ${activeView === SETTINGS_NAV_ITEM.id ? "is-active" : ""}`} type="button" onClick={() => onNavigate(SETTINGS_NAV_ITEM.id)} aria-current={activeView === SETTINGS_NAV_ITEM.id ? "page" : undefined}><Settings size={18} strokeWidth={1.8} aria-hidden="true" /><span>设置</span></button></div>
    </aside>
  );
}

export function MobileNav({ activeView, onNavigate, onMore, moreOpen, assistantActive = false, onAssistant, onCreate }: { activeView: AppView; onNavigate: (view: AppView) => void; onMore: () => void; moreOpen: boolean; assistantActive?: boolean; onAssistant?: () => void; onCreate: (kind: "journal" | "task") => void }) {
  const [creating, setCreating] = useState(false);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!creating) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setCreating(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setCreating(false); root.current?.querySelector<HTMLButtonElement>("#mobile-create-trigger")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [creating]);
  useEffect(() => setCreating(false), [activeView, assistantActive, moreOpen]);
  const moreActive = !assistantActive && (activeView === "dreams" || MOBILE_MORE_ITEMS.some((item) => item.id === activeView));
  return <nav ref={root} className="mobile-nav" aria-label="移动端导航">{MOBILE_NAV_ITEMS.map((item, index) => {
    const Icon = item.icon;
    const destination = item.id, selected = assistantActive ? destination === "assistant" : activeView === destination;
    return <Fragment key={destination}>{index === 2 ? <button id="mobile-create-trigger" className={`mobile-nav-item ${creating ? "is-active" : ""}`} type="button" aria-label="新建记录" aria-expanded={creating} aria-controls="mobile-create-menu" onClick={() => setCreating(value => !value)}><Plus size={19} strokeWidth={1.8} aria-hidden="true" /><span>新建</span></button> : null}<button className={`mobile-nav-item ${selected ? "is-active" : ""}`} type="button" onClick={() => { setCreating(false); if (destination === "assistant") onAssistant?.(); else onNavigate(destination); }} aria-current={selected ? "page" : undefined}><Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span></button></Fragment>;
  })}<button id="mobile-more-trigger" className={`mobile-nav-item ${moreActive ? "is-active" : ""}`} type="button" onClick={onMore} aria-controls="mobile-more-menu" aria-expanded={moreOpen}><MoreHorizontal size={19} strokeWidth={1.8} aria-hidden="true" /><span>更多</span></button>{creating ? <div id="mobile-create-menu" className="mobile-create-menu" role="group" aria-label="新建记录类型"><button type="button" onClick={() => { setCreating(false); onCreate("journal"); }}><NotebookPen size={19} /><span>写日记</span></button><button type="button" onClick={() => { setCreating(false); onCreate("task"); }}><ListChecks size={19} /><span>添加任务</span></button></div> : null}</nav>;
}

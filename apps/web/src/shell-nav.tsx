import { Settings, MoreHorizontal, type LucideIcon } from "lucide-react";
import type { AppView } from "./app-types";
import { MOBILE_MORE_ITEMS, MOBILE_NAV_ITEMS, NAV_ITEMS, SETTINGS_NAV_ITEM } from "./app-meta";

export function Sidebar({ activeView, onNavigate }: { activeView: AppView; onNavigate: (view: AppView) => void }) {
  return (
    <aside className="sidebar" aria-label="LifeOS 导航">
      <div className="brand-lockup"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span className="brand-name">LifeOS</span></div>
      <nav className="primary-nav" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return <button className={`nav-item ${activeView === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => onNavigate(item.id)} aria-current={activeView === item.id ? "page" : undefined}><Icon size={18} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span></button>;
        })}
      </nav>
      <div className="sidebar-footer"><button className={`nav-item sidebar-settings-item ${activeView === SETTINGS_NAV_ITEM.id ? "is-active" : ""}`} type="button" onClick={() => onNavigate(SETTINGS_NAV_ITEM.id)} aria-current={activeView === SETTINGS_NAV_ITEM.id ? "page" : undefined}><Settings size={18} strokeWidth={1.8} aria-hidden="true" /><span>设置</span></button></div>
    </aside>
  );
}

export function MobileNav({ activeView, onNavigate, onMore, moreOpen }: { activeView: AppView; onNavigate: (view: AppView) => void; onMore: () => void; moreOpen: boolean }) {
  const moreActive = MOBILE_MORE_ITEMS.some((item) => item.id === activeView);
  return <nav className="mobile-nav" aria-label="移动端导航">{MOBILE_NAV_ITEMS.map((item) => {
    const Icon = item.icon;
    return <button className={`mobile-nav-item ${activeView === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => onNavigate(item.id)} aria-current={activeView === item.id ? "page" : undefined}><Icon size={19} strokeWidth={1.8} aria-hidden="true" /><span>{item.label}</span></button>;
  })}<button id="mobile-more-trigger" className={`mobile-nav-item ${moreActive ? "is-active" : ""}`} type="button" onClick={onMore} aria-controls="mobile-more-menu" aria-expanded={moreOpen}><MoreHorizontal size={19} strokeWidth={1.8} aria-hidden="true" /><span>更多</span></button></nav>;
}

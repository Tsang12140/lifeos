import type { SVGProps } from "react";

// Owner-approved archive, checked 2026-11-02: https://ai.dnbox.cn/icon/
// Exact local copies of icons/check-3.svg and icons/lock.svg. No remote runtime fetch.
type ArchiveIconProps = SVGProps<SVGSVGElement> & { size?: number };
export function ArchiveCheckIcon({ size = 17, ...props }: ArchiveIconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon-id="check-3" {...props}><path d="M20 6 9 17l-5-5" /></svg>;
}
// Owner archive, checked 2026-11-06: icons/lib-columns-2.svg, icons/lib-columns-3.svg,
// icons/lib-columns-4.svg (页面导航, Lucide origin). Exact local copies, no runtime fetch.
export function ArchiveColumnsIcon({ count, size = 16, ...props }: ArchiveIconProps & { count: 2 | 3 | 4 }) {
  const lines = count === 2 ? ["M12 3v18"] : count === 3 ? ["M9 3v18", "M15 3v18"] : ["M7.5 3v18", "M12 3v18", "M16.5 3v18"];
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon-id={`lib-columns-${count}`} {...props}><rect width="18" height="18" x="3" y="3" rx="2" />{lines.map((d) => <path key={d} d={d} />)}</svg>;
}
export function ArchiveLockIcon({ size = 20, ...props }: ArchiveIconProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-icon-id="lock" {...props}><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>;
}

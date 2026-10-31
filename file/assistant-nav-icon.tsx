import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { assistantGlyphPath } from "./assistant-logo-path";

// 叠纸图形本身就是无圆盘的实心形，直接引用，不再对圆盘路径做字符串切分。
export const AssistantNavIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(function AssistantNavIcon({ size = 24, ...props }, ref) {
  return <svg {...props} ref={ref} width={size} height={size} viewBox="131 131 762 762" fill="currentColor" stroke="none" aria-hidden="true"><path d={assistantGlyphPath} /></svg>;
});

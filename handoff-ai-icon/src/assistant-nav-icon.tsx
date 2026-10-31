import { forwardRef } from "react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { assistantLogoPath } from "./assistant-logo-path";

// Reuse the existing mark without its launcher disc; preserve the subpath origin.
const glyph = assistantLogoPath.slice(assistantLogoPath.indexOf(" m-0.021333"))
  .replace(/^ m-0\.021333 170\.666667/, "M511.978667 170.666667");
export const AssistantNavIcon: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(function AssistantNavIcon({ size = 24, ...props }, ref) {
  return <svg {...props} ref={ref} width={size} height={size} viewBox="144 144 736 736" fill="currentColor" stroke="none" aria-hidden="true"><path d={glyph} /></svg>;
});

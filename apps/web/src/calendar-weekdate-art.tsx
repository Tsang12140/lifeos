import weekdateGlyphsUrl from "./assets/calendar-weekdate-glyphs.svg?url";

const WEEKDAY_GLYPHS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

function glyph(char: string, key: string) {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return null;
  const symbol = `calendar-weekdate-u${codePoint.toString(16).padStart(4, "0")}`;
  return <svg className="week-card-mobile-glyph" key={key} viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true">
    <use href={`${weekdateGlyphsUrl}#${symbol}`} x="0" y="0" width="1000" height="1000" />
  </svg>;
}

function weekdayFor(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const index = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return WEEKDAY_GLYPHS[index] ?? "周一";
}

/** The decorative Huiwen Mincho heading used by mobile week cards only. */
export function CalendarWeekCardHeading({ date }: { readonly date: string }) {
  const weekday = weekdayFor(date);
  const day = String(Number(date.slice(8, 10)));
  return <span className="week-card-mobile-heading" aria-hidden="true">
    <span className="week-card-mobile-weekday">{Array.from(weekday, (char, index) => glyph(char, `weekday-${index}`))}</span>
    <span className="week-card-mobile-day">{Array.from(day, (char, index) => glyph(char, `day-${index}`))}</span>
  </span>;
}

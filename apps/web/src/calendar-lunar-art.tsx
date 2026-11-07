import lunarGlyphsUrl from "./assets/calendar-lunar-glyphs.svg?url";

/** Retro Huiwen Mincho outlines, selected by actual simplified lunar characters. */
export function CalendarLunarArt({ label }: { label: string }) {
  return <span className="calendar-week-lunar" data-lunar-date={label} aria-hidden="true">
    {Array.from(label).map((char, index) => <svg className="calendar-lunar-glyph" data-lunar-char={char} key={index} viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid meet" focusable="false" aria-hidden="true"><use href={`${lunarGlyphsUrl}#calendar-lunar-u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`} x="0" y="0" width="1000" height="1000" /></svg>)}
  </span>;
}

/** Poster-only breaks. Source offsets and explicit newlines stay with the caller. */
export interface ShareWrapToken { readonly text: string; readonly kind: "text" | "citation" }
export interface ShareWrapLine { readonly start: number; readonly end: number }
const noStart = /^[，。、；：！？）》】」』〉〕］｝’”…,.!?;:%‰)\]}]/u;
const noEnd = /[（《【「『〈〔［｛‘“(\[{]$/u;
const content = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

export function wrapShareParagraph(tokens: readonly ShareWrapToken[], width: number, measure: (start: number, end: number, tracking: number) => number, size: number, title: boolean, canTrack = true): { lines: ShareWrapLine[]; tracking: number } {
  const legal = (at: number) => at === 0 || at === tokens.length ||
    (!noEnd.test(tokens[at - 1]!.text) && tokens[at]!.kind !== "citation" && !noStart.test(tokens[at]!.text));
  const wrap = (tracking: number) => {
    const lines: ShareWrapLine[] = [];
    for (let start = 0; start < tokens.length;) {
      let end = start + 1;
      while (end < tokens.length && measure(start, end + 1, tracking) <= width) end++;
      if (end < tokens.length) {
        let boundary = end;
        while (boundary > start && !legal(boundary)) boundary--;
        if (boundary > start) end = boundary;
      }
      lines.push({ start, end }); start = end;
    }
    return lines;
  };
  const count = (line: ShareWrapLine) => tokens.slice(line.start, line.end).filter(token => token.kind === "text" && content.test(token.text)).length;
  let lines = wrap(0);
  const orphan = lines.length > 1 && count(lines.at(-1)!) === 1;
  // Tightening is useful only if it removes the orphan line entirely. Never
  // squeeze a whole paragraph merely to redistribute its last two lines.
  if (orphan && canTrack) {
    const limit = -size * .02;
    if (wrap(limit).length < lines.length) {
      let fits = limit, misses = 0;
      for (let i = 0; i < 10; i++) {
        const mid = (fits + misses) / 2;
        if (wrap(mid).length < lines.length) fits = mid; else misses = mid;
      }
      return { lines: wrap(fits), tracking: fits };
    }
  }
  // A two-line heading can pause at existing punctuation. Both sides must
  // retain a useful measure; this is not paragraph-wide balanced wrapping.
  if (title && lines.length === 2) {
    let best: number | undefined, score = Infinity;
    for (let at = 1; at < tokens.length; at++) {
      if (!/[，。；：！？、,;:!?]$/u.test(tokens[at - 1]!.text) || !legal(at)) continue;
      const left = measure(0, at, 0), right = measure(at, tokens.length, 0);
      if (Math.max(left, right) > width || Math.min(left, right) < width * .35) continue;
      if (Math.abs(left - right) < score) { best = at; score = Math.abs(left - right); }
    }
    if (best !== undefined) return { lines: [{ start: 0, end: best }, { start: best, end: tokens.length }], tracking: 0 };
  }
  if (orphan) {
    const last = lines.at(-1)!, prior = lines.at(-2)!;
    // Keep preceding lines full. Move at most two content graphemes plus
    // attached punctuation, never a phrase or half a line. Author breaks stay.
    const candidates: { at: number; letters: number }[] = [];
    for (let at = prior.end - 1; at > prior.start; at--) {
      const letters = count({ start: at, end: prior.end });
      if (letters > 2) break;
      if (letters && legal(at)) candidates.push({ at, letters });
    }
    for (const { at } of candidates.sort((a, b) => b.letters - a.letters || b.at - a.at)) {
      if (at <= prior.start || !legal(at) || measure(at, last.end, 0) > width || count({ start: at, end: last.end }) < 2) continue;
      if (measure(prior.start, at, 0) < width * .7) continue;
      lines = [...lines.slice(0, -2), { start: prior.start, end: at }, { start: at, end: last.end }]; break;
    }
  }
  return { lines, tracking: 0 };
}

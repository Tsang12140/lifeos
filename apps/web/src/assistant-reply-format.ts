export interface ReplyRun {
  readonly text: string;
  readonly strong: boolean;
}

/** A small text-only format: paragraphs and short emphasis, never model HTML. */
export function replyParagraphs(text: string): readonly (readonly ReplyRun[])[] {
  let emphasisCount = 0;
  return text.replace(/\r\n?/g, "\n").split(/\n[\t ]*\n+/).filter(paragraph => paragraph.trim()).map(paragraph => {
    const runs: ReplyRun[] = [];
    let at = 0;
    for (const match of paragraph.matchAll(/\*\*([^*\n]+)\*\*/g)) {
      if (match.index! > at) runs.push({ text: paragraph.slice(at, match.index), strong: false });
      const content = match[1]!;
      // Keep excessive/paragraph-long emphasis readable without changing stored text.
      const strong = emphasisCount < 2 && content.trim().length > 0 && content.length <= 40 && paragraph.trim() !== match[0];
      if (strong) emphasisCount++;
      runs.push({ text: content, strong });
      at = match.index! + match[0].length;
    }
    if (at < paragraph.length) runs.push({ text: paragraph.slice(at), strong: false });
    return runs;
  });
}

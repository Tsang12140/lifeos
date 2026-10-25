export interface AssistantCitationRange { readonly start: number; readonly end: number; readonly number: number }

/** Reserved source markers in prose only; code and Markdown links are content. */
export function assistantCitationRanges(text: string): readonly AssistantCitationRange[] {
  const ranges: AssistantCitationRange[] = [];
  let offset = 0, fence = "", inline = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const delimiter = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = "";
      offset += line.length; inline = 0; continue;
    }
    if (fence) { offset += line.length; continue; }
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") { i++; continue; }
      if (line[i] === "`") {
        const count = /^`+/.exec(line.slice(i))![0].length;
        if (!inline) inline = count; else if (count === inline) inline = 0;
        i += count - 1; continue;
      }
      if (inline || line[i] !== "[") continue;
      const match = /^\[([1-9]\d?)\]/.exec(line.slice(i));
      if (!match) continue;
      const end = i + match[0].length;
      if (line[end] !== "(" && line[end] !== "[" && line[end] !== ":") ranges.push({ start: offset + i, end: offset + end, number: Number(match[1]) });
      i = end - 1;
    }
    offset += line.length;
  }
  return ranges;
}

/** A narrow structural signal, not a claim to judge semantic completeness. */
export function hasOrphanAssistantCitation(text: string): boolean {
  const ranges = assistantCitationRanges(text);
  for (const range of ranges) {
    const before = text.slice(0, range.start);
    const paragraph = before.split(/\n[ \t]*\n/).at(-1)!.trim();
    if (!paragraph.replace(/[*_~]/g, "")) return true;
    const lineStart = before.lastIndexOf("\n") + 1;
    const lineEnd = text.indexOf("\n", range.end);
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (/^[ \t]*(?:\[\d{1,2}\][ \t]*)+[。．.，,、：:；;！？!? \t]*$/.test(line)) return true;
  }
  return false;
}

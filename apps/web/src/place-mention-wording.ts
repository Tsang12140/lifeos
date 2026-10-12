import type { TextEntityDecision } from "@lifeos/core";

/** Only the explicit occurrence changes; entity names and global aliases do not. */
export function applyPlaceWording(text: string, range: { start: number; end: number; text: string }, wording: string, decisions: readonly TextEntityDecision[]) {
  const label = wording.trim();
  if (!label || label.length > 100 || text.slice(range.start, range.end) !== range.text) throw new Error("invalid_place_wording");
  const target = decisions.find(item => item.start === range.start && item.end === range.end && item.entityType === "place" && item.entityId);
  if (!target || label === range.text) return { text, decisions };
  const difference = label.length - (range.end - range.start);
  return {
    text: text.slice(0, range.start) + label + text.slice(range.end),
    decisions: decisions.flatMap(item => item === target ? [{ ...item, text: label, end: item.start + label.length }] : item.end <= range.start ? [item] : item.start >= range.end ? [{ ...item, start: item.start + difference, end: item.end + difference }] : []),
  };
}

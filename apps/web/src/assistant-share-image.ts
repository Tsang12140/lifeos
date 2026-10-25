import { apiRequest } from "./api";
import type { Asset } from "@lifeos/core";
import { shareMessageParts, type ShareMessage, type ShareMessagePart, type ShareRedaction, wrapShareText } from "./assistant-share-model";
import { assistantLogoPath } from "./assistant-logo-path";
import { assistantMessageTime } from "./assistant-message-time";
import { wrapShareParagraph } from "./assistant-share-wrap";

const WIDTH = 640, MARGIN = 48, TOP = 72, MIN_HEIGHT = Math.ceil(WIDTH * 4 / 3);
const TEXT_WIDTH = WIDTH - MARGIN * 2, SIZE = 23, LINE = 36, PARAGRAPH_GAP = 16;
// Two 390x844 phone screens at the same displayed width, independent of device.
const MAX_HEIGHT = Math.floor(WIDTH * 844 / 390 * 2);
const SERIF = '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif';
interface TextBlock {
  lines: { text: string; ascent: number; descent: number; leftBearing: number }[];
  width: number; height: number; baseline: number; lineHeight: number;
}
interface RichItem extends ShareMessagePart {
  readonly tracking: number;
  readonly x: number;
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
  readonly leftBearing: number;
  readonly rightBearing: number;
  readonly redaction?: ShareRedaction;
}
interface RichLine { readonly items: RichItem[]; width: number; ascent: number; descent: number; inkOffset: number; y: number }
interface RichTextBlock { lines: RichLine[]; height: number; baseline: number; lineHeight: number }
interface Media { image: HTMLImageElement | null; width: number; height: number; label?: TextBlock }
interface Row { messageId: string; user: boolean; y: number; text: RichTextBlock; time: TextBlock; timeY: number; media: Media[]; mediaY: number }
interface LoadedMessage { message: ShareMessage; media: { image: HTMLImageElement | null; name: string }[] }
export interface ShareTextPosition { readonly messageId: string; readonly text: string; readonly start: number; readonly end: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly font: string; readonly tracking: number }
export interface ShareTextLayout { readonly width: number; readonly height: number; readonly items: readonly ShareTextPosition[] }
export interface AssistantShareArtwork { readonly jpeg: Blob; readonly png: Blob; readonly generatedAt: string; readonly layout: ShareTextLayout }
const textLayouts = new WeakMap<HTMLCanvasElement, ShareTextLayout>();
const font = (family: string, size = SIZE, weight = 400) => `${weight} ${size}px ${family}`;
const citationSize = (size: number) => size * .56;
const citationHeight = (size: number) => citationSize(size) * 1.25;

/** Measure visible glyph bounds, not an assumed ascent or a CSS line-box center. */
function measureText(ctx: CanvasRenderingContext2D, text: string, width: number, family: string, size = SIZE, weight = 400, lineHeight = LINE): TextBlock {
  if (!text) return { lines: [], width: 0, height: 0, baseline: 0, lineHeight };
  ctx.font = font(family, size, weight);
  ctx.letterSpacing = "0px";
  const fallback = ctx.measureText("国Ag");
  const lines = wrapShareText(text, width - 4, value => ctx.measureText(value).width).map(value => {
    const metrics = ctx.measureText(value || "国Ag");
    return { text: value, ascent: metrics.actualBoundingBoxAscent || fallback.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent || 0, leftBearing: value ? metrics.actualBoundingBoxLeft : 0 };
  });
  const top = Math.min(...lines.map((line, index) => index * lineHeight - line.ascent));
  const bottom = Math.max(...lines.map((line, index) => index * lineHeight + line.descent));
  const inkWidth = Math.max(0, ...lines.map(line => line.leftBearing + ctx.measureText(line.text).actualBoundingBoxRight));
  return { lines, width: Math.ceil(inkWidth), height: bottom - top, baseline: -top, lineHeight };
}
function drawText(ctx: CanvasRenderingContext2D, block: TextBlock, x: number, y: number) {
  ctx.letterSpacing = "0px";
  // Serif glyphs can start inside their advance box (a negative left bearing).
  // Align each line's visible ink, including those inset glyphs, to the page edge.
  for (const [index, line] of block.lines.entries()) ctx.fillText(line.text, x + line.leftBearing, y + block.baseline + index * block.lineHeight);
}

function maskAt(messageId: string, start: number, end: number, redactions: readonly ShareRedaction[]) {
  return redactions.find(mask => mask.messageId === messageId && mask.start < end && mask.end > start);
}

function measureRichText(ctx: CanvasRenderingContext2D, message: ShareMessage, width: number, family: string, badgeFamily: string, size: number, lineHeight: number, redactions: readonly ShareRedaction[], defaultBold = false, paragraphGap = PARAGRAPH_GAP): RichTextBlock {
  const parts = shareMessageParts(message);
  if (!parts.length) return { lines: [], height: 0, baseline: 0, lineHeight };
  const fallbackFont = font(family, size);
  ctx.font = fallbackFont;
  const fallback = ctx.measureText("国Ag");
  const emptyLine = (): RichLine => ({ items: [], width: 0, ascent: 0, descent: 0, inkOffset: 0, y: 0 });
  const lines: RichLine[] = [emptyLine()];
  const maxWidth = width - 4;
  let tracking = 0;
  const add = (part: ShareMessagePart, text: string, start: number, end: number, mask?: ShareRedaction) => {
    const citation = part.kind === "citation";
    const badgeFontSize = citationSize(size);
    const strong = part.strong || defaultBold;
    ctx.font = citation ? font(badgeFamily, badgeFontSize, 600) : font(family, size, strong ? (defaultBold ? 700 : 600) : 400);
    ctx.letterSpacing = `${citation ? 0 : tracking}px`;
    const measuredText = citation ? String(part.number) : text;
    const metrics = ctx.measureText(measuredText || "国Ag");
    const itemWidth = citation ? Math.max(badgeFontSize * 1.2, metrics.width + badgeFontSize * .5) : metrics.width;
    let line = lines.at(-1)!;
    const x = line.width;
    const item: RichItem = {
      ...part, strong, text, start, end, x, width: itemWidth, tracking: citation ? 0 : tracking,
      ascent: citation ? size * .28 + citationHeight(size) : (metrics.actualBoundingBoxAscent || fallback.actualBoundingBoxAscent),
      descent: citation ? 0 : (metrics.actualBoundingBoxDescent || 0),
      leftBearing: citation ? 0 : (text ? metrics.actualBoundingBoxLeft : 0),
      rightBearing: citation ? itemWidth : (text ? metrics.actualBoundingBoxRight : 0),
      ...(mask ? { redaction: mask } : {}),
    };
    const prior = line.items.at(-1);
    const merge = !citation && prior && prior.kind === "text" && part.kind === "text" && prior.strong === strong && prior.redaction?.id === mask?.id && prior.end === start;
    if (merge && prior) {
      const priorIndex = line.items.length - 1;
      ctx.font = font(family, size, strong ? (defaultBold ? 700 : 600) : 400);
      const combined = ctx.measureText(prior.text + text);
      const nextWidth = combined.width;
      line.width += nextWidth - prior.width;
      line.items[priorIndex] = { ...prior, text: prior.text + text, end, width: nextWidth, ascent: combined.actualBoundingBoxAscent || fallback.actualBoundingBoxAscent, descent: combined.actualBoundingBoxDescent || 0, leftBearing: combined.actualBoundingBoxLeft, rightBearing: combined.actualBoundingBoxRight };
      line.ascent = Math.max(line.ascent, line.items[priorIndex]!.ascent);
      line.descent = Math.max(line.descent, line.items[priorIndex]!.descent);
      return;
    }
    line.items.push(item); line.width += itemWidth;
    line.ascent = Math.max(line.ascent, item.ascent); line.descent = Math.max(line.descent, item.descent);
  };
  const paragraphs: ShareMessagePart[][] = [[]];
  for (const part of parts) {
    if (part.kind === "citation") {
      paragraphs.at(-1)!.push(part);
      continue;
    }
    let offset = part.start;
    for (const { segment } of new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(part.text)) {
      if (segment === "\n") { paragraphs.push([]); offset += segment.length; continue; }
      paragraphs.at(-1)!.push({ ...part, text: segment, start: offset, end: offset + segment.length });
      offset += segment.length;
    }
  }
  for (const [index, tokens] of paragraphs.entries()) {
    if (index) lines.push(emptyLine());
    const measure = (start: number, end: number, spacing: number) => {
      let total = 0;
      for (let at = start; at < end;) {
        const token = tokens[at]!, strong = token.strong || defaultBold;
        if (token.kind === "citation") {
          const small = citationSize(size); ctx.font = font(badgeFamily, small, 600); ctx.letterSpacing = "0px";
          total += Math.max(small * 1.2, ctx.measureText(String(token.number)).width + small * .5); at++; continue;
        }
        let text = token.text; at++;
        while (at < end && tokens[at]!.kind === "text" && (tokens[at]!.strong || defaultBold) === strong) text += tokens[at++]!.text;
        ctx.font = font(family, size, strong ? (defaultBold ? 700 : 600) : 400); ctx.letterSpacing = `${spacing}px`;
        total += ctx.measureText(text).width;
      }
      return total;
    };
    const wrapped = wrapShareParagraph(tokens, maxWidth, measure, size, defaultBold, "letterSpacing" in CanvasRenderingContext2D.prototype);
    tracking = wrapped.tracking;
    for (const [lineIndex, range] of wrapped.lines.entries()) {
      if (lineIndex) lines.push(emptyLine());
      for (const part of tokens.slice(range.start, range.end)) add(part, part.text, part.start, part.end, maskAt(message.id, part.start, part.end, redactions));
    }
  }
  ctx.letterSpacing = "0px";
  // Blank lines mark paragraph spacing instead of consuming full line boxes.
  // Keep source offsets intact for selection and redaction across paragraphs.
  const visibleLines: RichLine[] = [];
  let paragraphBreak = false;
  for (const line of lines) {
    if (line.items.every(item => item.kind === "text" && !item.text.trim())) {
      if (visibleLines.length) paragraphBreak = true;
      continue;
    }
    const previous = visibleLines.at(-1);
    line.y = previous ? previous.y + lineHeight + (paragraphBreak ? paragraphGap : 0) : 0;
    visibleLines.push(line);
    paragraphBreak = false;
  }
  if (!visibleLines.length) return { lines: [], height: 0, baseline: 0, lineHeight };
  // Only the start of a whole line aligns its ink to the margin. Inline runs
  // retain their natural side bearings, particularly punctuation after bold.
  for (const line of visibleLines) line.inkOffset = line.items[0]?.leftBearing ?? 0;
  const top = Math.min(...visibleLines.map(line => line.y - line.ascent));
  const bottom = Math.max(...visibleLines.map(line => line.y + line.descent));
  return { lines: visibleLines, height: bottom - top, baseline: -top, lineHeight };
}

function drawBlurred(ctx: CanvasRenderingContext2D, item: RichItem, x: number, baseline: number, family: string, size: number, color: string, defaultBold: boolean) {
  const blur = Math.max(2, Math.min(16, item.redaction?.strength ?? 10));
  const padding = blur * 2 + 3;
  const logicalWidth = Math.max(1, item.width + padding * 2);
  const logicalHeight = Math.max(1, item.ascent + item.descent + padding * 2);
  const scale = 2;
  const scratch = document.createElement("canvas");
  scratch.width = Math.ceil(logicalWidth * scale); scratch.height = Math.ceil(logicalHeight * scale);
  const layer = scratch.getContext("2d");
  if (!layer) return;
  layer.scale(scale, scale); layer.font = font(family, size, defaultBold ? 700 : item.strong ? 600 : 400); layer.fillStyle = color;
  layer.letterSpacing = `${item.tracking}px`;
  layer.filter = `blur(${blur}px)`;
  layer.fillText(item.text, padding, padding + item.ascent);
  layer.filter = "none";
  ctx.drawImage(scratch, x - padding, baseline - item.ascent - padding, logicalWidth, logicalHeight);
  scratch.width = 1; scratch.height = 1;
}

function drawRichText(ctx: CanvasRenderingContext2D, block: RichTextBlock, x: number, y: number, family: string, badgeFamily: string, size: number, color: string, defaultBold = false) {
  for (const line of block.lines) {
    const baseline = y + block.baseline + line.y;
    const lineX = x + line.inkOffset;
    for (const item of line.items) {
      ctx.letterSpacing = `${item.tracking}px`;
      const itemX = lineX + item.x;
      if (item.redaction?.mode === "block") {
        const top = baseline - item.ascent - 2, height = Math.max(8, item.ascent + item.descent + 4);
        ctx.fillStyle = "#41484e"; ctx.beginPath(); ctx.roundRect(itemX - 3, top, item.width + 6, height, 4); ctx.fill();
      } else if (item.redaction?.mode === "blur") {
        if (item.kind === "citation") {
          const top = baseline - size * .28 - citationHeight(size);
          const height = citationHeight(size);
          const blur = Math.max(2, Math.min(16, item.redaction.strength)), padding = blur * 2 + 3;
          const blurred = document.createElement("canvas"); blurred.width = Math.ceil((item.width + padding * 2) * 2); blurred.height = Math.ceil((height + padding * 2) * 2);
          const layer = blurred.getContext("2d");
          if (layer) { layer.scale(2, 2); layer.font = font(badgeFamily, citationSize(size), 600); layer.fillStyle = "#53657b"; layer.filter = `blur(${blur}px)`; layer.fillText(String(item.number), padding, padding + height * .8); layer.filter = "none"; ctx.drawImage(blurred, itemX - padding, top - padding, item.width + padding * 2, height + padding * 2); }
          blurred.width = 1; blurred.height = 1;
        } else drawBlurred(ctx, item, itemX, baseline, family, size, color, defaultBold);
      } else if (item.kind === "citation") {
        const smallSize = citationSize(size), badgeHeight = citationHeight(size), badgeTop = baseline - size * .28 - badgeHeight;
        ctx.fillStyle = "#e9edf2"; ctx.beginPath(); ctx.roundRect(itemX, badgeTop, item.width, badgeHeight, badgeHeight / 2); ctx.fill();
        ctx.font = font(badgeFamily, smallSize, 600); ctx.fillStyle = "#53657b";
        const value = String(item.number), labelWidth = ctx.measureText(value).width;
        ctx.fillText(value, itemX + (item.width - labelWidth) / 2, badgeTop + badgeHeight * .78);
      } else {
        ctx.font = font(family, size, defaultBold ? 700 : item.strong ? 600 : 400); ctx.fillStyle = color;
        ctx.fillText(item.text, itemX, baseline);
      }
    }
  }
  ctx.letterSpacing = "0px";
}
function logo(ctx: CanvasRenderingContext2D, path: Path2D, x: number, y: number, size: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 1024, size / 1024);
  ctx.fillStyle = "#68717c"; ctx.fill(path); ctx.restore();
}
function photo(assetId: string, imageCache: Map<string, Promise<HTMLImageElement | null>>): Promise<HTMLImageElement | null> {
  const cached = imageCache.get(assetId); if (cached) return cached;
  const loaded = (async () => {
    const asset = await apiRequest<Asset>(`/api/assets/${encodeURIComponent(assetId)}`);
    if (asset.kind !== "photo") return null;
    const image = new Image(); image.src = `/api/assets/${encodeURIComponent(assetId)}/content`;
    await image.decode(); return image;
  })();
  imageCache.set(assetId, loaded);
  void loaded.catch(() => imageCache.delete(assetId));
  return loaded;
}

/** Render an in-memory preview canvas; no data leaves the browser. */
export async function renderAssistantShareCanvas(messages: readonly ShareMessage[], redactions: readonly ShareRedaction[] = [], generatedAt = new Date(), imageCache = new Map<string, Promise<HTMLImageElement | null>>()): Promise<HTMLCanvasElement> {
  if (!messages.length) throw new Error("请先勾选要分享的消息");
  if (messages.length > 300 || messages.reduce((sum, message) => sum + message.text.length, 0) > 100_000) throw new Error("选中的对话太长，请减少几条后再生成图片");
  if (redactions.some(mask => mask.mode === "blur")) {
    const context = document.createElement("canvas").getContext("2d");
    if (!context || !("filter" in context)) throw new Error("当前浏览器不支持高斯模糊，请改用灰黑遮挡");
  }
  await document.fonts.ready;
  const brandFamily = getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
  await Promise.all([document.fonts.load(font(SERIF)), document.fonts.load(font(SERIF, 28, 700)), document.fonts.load(font(brandFamily, 14, 500))]);
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器暂时无法生成图片");
  const loaded: LoadedMessage[] = [];
  for (const message of messages) {
    const media: LoadedMessage["media"] = [];
    for (const attachment of message.attachments ?? []) {
      let image: HTMLImageElement | null;
      try { image = await photo(attachment.assetId, imageCache); }
      catch { throw new Error(`附件“${attachment.name}”无法读取，请恢复附件或取消勾选这条消息`); }
      media.push({ image, name: attachment.name });
    }
    loaded.push({ message, media });
  }
  const layout = (size: number) => {
    const rows: Row[] = [], density = size / SIZE;
    let y = TOP, questionSeen = false;
    for (const { message, media: assets } of loaded) {
      const user = message.role === "user";
      if (rows.length) y += Math.round((user ? 44 : 32) * density);
      const time = measureText(ctx, user || !questionSeen ? assistantMessageTime(message.at, generatedAt) : "", TEXT_WIDTH, brandFamily, 12, 400, 18);
      if (user) questionSeen = true;
      const timeY = y; if (time.height) y += time.height + 10;
      const textSize = user ? size + 5 : size, lineHeight = Math.round((user ? 42 : LINE) * density);
      // Masks never participate in wrapping: selection and export keep identical positions.
      const text = measureRichText(ctx, message, TEXT_WIDTH, SERIF, brandFamily, textSize, lineHeight, [], user, Math.round(PARAGRAPH_GAP * density));
      const media: Media[] = assets.map(asset => {
        if (asset.image) {
          const scale = Math.min(TEXT_WIDTH / asset.image.naturalWidth, 320 * density / asset.image.naturalHeight);
          return { image: asset.image, width: asset.image.naturalWidth * scale, height: asset.image.naturalHeight * scale };
        }
        const label = measureText(ctx, asset.name, TEXT_WIDTH, brandFamily, 14, 400, 22);
        return { image: null, width: label.width, height: label.height, label };
      });
      const afterTextY = y + text.height;
      const mediaY = afterTextY + (text.height && media.length ? Math.round(20 * density) : 0);
      rows.push({ messageId: message.id, user, y, text, time, timeY, media, mediaY });
      y = media.length ? mediaY + media.reduce((sum, item) => sum + item.height, 0) + (media.length - 1) * 16 : afterTextY;
    }
    return { rows, size, height: Math.max(MIN_HEIGHT, Math.ceil(y + Math.round(88 * density) + 20 + MARGIN)) };
  };
  // Reflow text at each real font size, rather than shrinking the complete bitmap.
  let page = layout(SIZE);
  for (const size of [22, 21, 20]) { if (page.height <= MAX_HEIGHT) break; page = layout(size); }
  if (page.height > MAX_HEIGHT) throw new Error("内容超过两屏，已缩至最小字号，请减少勾选后再生成");
  const { rows, height, size } = page;
  const positions: ShareTextPosition[] = [];
  for (const row of rows) for (const line of row.text.lines) for (const item of line.items) {
    const textSize = row.user ? size + 5 : size;
    const baseline = row.y + row.text.baseline + line.y;
    positions.push({ messageId: row.messageId, text: item.text, start: item.start, end: item.end,
      x: MARGIN + line.inkOffset + item.x, y: baseline - item.ascent, width: item.width,
      height: item.ascent + item.descent, font: font(SERIF, textSize, row.user ? 700 : item.strong ? 600 : 400), tracking: item.tracking });
  }
  textLayouts.set(canvas, { width: WIDTH, height, items: positions });
  canvas.width = WIDTH * 2; canvas.height = height * 2; ctx.scale(2, 2);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, WIDTH, height);
  for (const row of rows) {
    ctx.fillStyle = "#78818b"; ctx.font = font(brandFamily, 12);
    drawText(ctx, row.time, MARGIN, row.timeY);
    ctx.fillStyle = row.user ? "#222222" : "#343434";
    const textSize = row.user ? size + 5 : size;
    const masks = redactions.filter(mask => mask.messageId === row.messageId);
    const masked: RichTextBlock = { ...row.text, lines: row.text.lines.map(line => ({ ...line, items: line.items.flatMap(item => {
      if (item.kind !== "text") return [{ ...item, redaction: maskAt(row.messageId, item.start, item.end, masks) }];
      const cuts = [...new Set([item.start, item.end, ...masks.flatMap(mask => [mask.start, mask.end]).filter(at => at > item.start && at < item.end)])].sort((a, b) => a - b);
      ctx.font = font(SERIF, textSize, row.user ? 700 : item.strong ? 600 : 400);
      ctx.letterSpacing = `${item.tracking}px`;
      return cuts.slice(0, -1).map((start, index) => {
        const end = cuts[index + 1]!, text = item.text.slice(start - item.start, end - item.start);
        const metrics = ctx.measureText(text), prefix = ctx.measureText(item.text.slice(0, start - item.start)).width;
        return { ...item, text, start, end, x: item.x + prefix, width: metrics.width,
          leftBearing: metrics.actualBoundingBoxLeft, rightBearing: metrics.actualBoundingBoxRight,
          redaction: maskAt(row.messageId, start, end, masks) };
      });
    }) })) };
    drawRichText(ctx, masked, MARGIN, row.y, SERIF, brandFamily, textSize, row.user ? "#222222" : "#343434", row.user);
    let mediaY = row.mediaY;
    for (const media of row.media) {
      if (media.image) {
        ctx.save(); ctx.beginPath(); ctx.roundRect(MARGIN, mediaY, media.width, media.height, 8); ctx.clip();
        ctx.drawImage(media.image, MARGIN, mediaY, media.width, media.height); ctx.restore();
      } else if (media.label) {
        ctx.font = font(brandFamily, 14); ctx.fillStyle = "#68717c"; drawText(ctx, media.label, MARGIN, mediaY);
      }
      mediaY += media.height + 16;
    }
  }
  const brand = measureText(ctx, "LifeOS AI管家", TEXT_WIDTH, brandFamily, 14, 500, 20);
  const brandX = WIDTH - MARGIN - brand.width, footerY = height - MARGIN - 20;
  logo(ctx, new Path2D(assistantLogoPath), brandX - 30, footerY, 20);
  ctx.font = font(brandFamily, 14, 500); ctx.fillStyle = "#68717c";
  drawText(ctx, brand, brandX, footerY + (20 - brand.height) / 2);
  const generated = measureText(ctx, `生成于 ${assistantMessageTime(generatedAt.toISOString(), generatedAt)}`, brandX - 30 - MARGIN - 20, brandFamily, 12, 400, 18);
  ctx.font = font(brandFamily, 12); ctx.fillStyle = "#78818b";
  drawText(ctx, generated, MARGIN, footerY + (20 - generated.height) / 2);
  return canvas;
}

export async function encodeAssistantShareCanvas(canvas: HTMLCanvasElement, generatedAt: Date): Promise<AssistantShareArtwork> {
  const encode = (type: string) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob?.type === type ? resolve(blob) : reject(new Error("图片生成失败，请重试")), type, .93));
  const [jpeg, png] = await Promise.all([encode("image/jpeg"), encode("image/png")]);
  const layout = textLayouts.get(canvas);
  if (!layout) throw new Error("图片排版信息缺失，请重新生成");
  return { jpeg, png, generatedAt: generatedAt.toISOString(), layout };
}

/** Immutable local artwork; original message times and export time have distinct roles. */
export async function createAssistantShareArtwork(messages: readonly ShareMessage[], generatedAt = new Date(), redactions: readonly ShareRedaction[] = [], imageCache = new Map<string, Promise<HTMLImageElement | null>>()): Promise<AssistantShareArtwork> {
  const canvas = await renderAssistantShareCanvas(messages, redactions, generatedAt, imageCache);
  try { return await encodeAssistantShareCanvas(canvas, generatedAt); }
  finally { canvas.width = 1; canvas.height = 1; }
}
export async function createAssistantShareJpg(messages: readonly ShareMessage[], generatedAt = new Date()): Promise<Blob> {
  return (await createAssistantShareArtwork(messages, generatedAt)).jpeg;
}

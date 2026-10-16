import { apiRequest } from "./api";
import type { Asset } from "@lifeos/core";
import { wrapShareText, type ShareMessage } from "./assistant-share-model";
import { assistantLogoPath } from "./assistant-logo-path";
import { assistantMessageTime } from "./assistant-message-time";

const WIDTH = 640, MARGIN = 48, TOP = 72, MIN_HEIGHT = Math.ceil(WIDTH * 4 / 3);
const TEXT_WIDTH = WIDTH - MARGIN * 2, SIZE = 23, LINE = 39;
// Two 390x844 phone screens at the same displayed width, independent of device.
const MAX_HEIGHT = Math.floor(WIDTH * 844 / 390 * 2);
const SERIF = '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", "Source Han Serif SC", serif';
interface TextBlock {
  lines: { text: string; ascent: number; descent: number; leftBearing: number }[];
  width: number; height: number; baseline: number; lineHeight: number;
}
interface Media { image: HTMLImageElement | null; width: number; height: number; label?: TextBlock }
interface Row { user: boolean; y: number; text: TextBlock; time: TextBlock; timeY: number; media: Media[]; mediaY: number }
interface LoadedMessage { message: ShareMessage; media: { image: HTMLImageElement | null; name: string }[] }
export interface AssistantShareArtwork { readonly jpeg: Blob; readonly png: Blob; readonly generatedAt: string }
const font = (family: string, size = SIZE, weight = 400) => `${weight} ${size}px ${family}`;

/** Measure visible glyph bounds, not an assumed ascent or a CSS line-box center. */
function measureText(ctx: CanvasRenderingContext2D, text: string, width: number, family: string, size = SIZE, weight = 400, lineHeight = LINE): TextBlock {
  if (!text) return { lines: [], width: 0, height: 0, baseline: 0, lineHeight };
  ctx.font = font(family, size, weight);
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
  // Serif glyphs can start inside their advance box (a negative left bearing).
  // Align each line's visible ink, including those inset glyphs, to the page edge.
  for (const [index, line] of block.lines.entries()) ctx.fillText(line.text, x + line.leftBearing, y + block.baseline + index * block.lineHeight);
}
function logo(ctx: CanvasRenderingContext2D, path: Path2D, x: number, y: number, size: number) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 1024, size / 1024);
  ctx.fillStyle = "#68717c"; ctx.fill(path); ctx.restore();
}
async function photo(assetId: string): Promise<HTMLImageElement | null> {
  const asset = await apiRequest<Asset>(`/api/assets/${encodeURIComponent(assetId)}`);
  if (asset.kind !== "photo") return null;
  const image = new Image(); image.src = `/api/assets/${encodeURIComponent(assetId)}/content`;
  await image.decode(); return image;
}

/** Immutable local artwork; original message times and export time have distinct roles. */
export async function createAssistantShareArtwork(messages: readonly ShareMessage[], generatedAt = new Date()): Promise<AssistantShareArtwork> {
  if (!messages.length) throw new Error("请先勾选要分享的消息");
  if (messages.length > 300 || messages.reduce((sum, message) => sum + message.text.length, 0) > 100_000) throw new Error("选中的对话太长，请减少几条后再生成图片");
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
      try { image = await photo(attachment.assetId); }
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
      if (rows.length) y += Math.round((user ? 44 : 24) * density);
      const time = measureText(ctx, user || !questionSeen ? assistantMessageTime(message.at, generatedAt) : "", TEXT_WIDTH, brandFamily, 12, 400, 18);
      if (user) questionSeen = true;
      const timeY = y; if (time.height) y += time.height + 10;
      const text = measureText(ctx, message.text, TEXT_WIDTH, SERIF, user ? size + 5 : size, user ? 700 : 400, Math.round((user ? 42 : LINE) * density));
      const media: Media[] = assets.map(asset => {
        if (asset.image) {
          const scale = Math.min(TEXT_WIDTH / asset.image.naturalWidth, 320 * density / asset.image.naturalHeight);
          return { image: asset.image, width: asset.image.naturalWidth * scale, height: asset.image.naturalHeight * scale };
        }
        const label = measureText(ctx, asset.name, TEXT_WIDTH, brandFamily, 14, 400, 22);
        return { image: null, width: label.width, height: label.height, label };
      });
      const mediaY = y + text.height + (text.height && media.length ? Math.round(20 * density) : 0);
      rows.push({ user, y, text, time, timeY, media, mediaY });
      y = media.length ? mediaY + media.reduce((sum, item) => sum + item.height, 0) + (media.length - 1) * 16 : y + text.height;
    }
    return { rows, size, height: Math.max(MIN_HEIGHT, Math.ceil(y + Math.round(88 * density) + 20 + MARGIN)) };
  };
  // Reflow text at each real font size, rather than shrinking the complete bitmap.
  let page = layout(SIZE);
  for (const size of [22, 21, 20]) { if (page.height <= MAX_HEIGHT) break; page = layout(size); }
  if (page.height > MAX_HEIGHT) throw new Error("内容超过两屏，已缩至最小字号，请减少勾选后再生成");
  const { rows, height, size } = page;
  canvas.width = WIDTH * 2; canvas.height = height * 2; ctx.scale(2, 2);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, WIDTH, height);
  for (const row of rows) {
    ctx.fillStyle = "#78818b"; ctx.font = font(brandFamily, 12);
    drawText(ctx, row.time, MARGIN, row.timeY);
    ctx.fillStyle = row.user ? "#222222" : "#343434";
    ctx.font = font(SERIF, row.user ? size + 5 : size, row.user ? 700 : 400);
    drawText(ctx, row.text, MARGIN, row.y);
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
  try {
    const encode = (type: string) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob?.type === type ? resolve(blob) : reject(new Error("图片生成失败，请重试")), type, .93));
    const [jpeg, png] = await Promise.all([encode("image/jpeg"), encode("image/png")]);
    return { jpeg, png, generatedAt: generatedAt.toISOString() };
  } finally { canvas.width = 1; canvas.height = 1; }
}
export async function createAssistantShareJpg(messages: readonly ShareMessage[], generatedAt = new Date()): Promise<Blob> {
  return (await createAssistantShareArtwork(messages, generatedAt)).jpeg;
}

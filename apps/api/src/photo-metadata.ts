import { photoDetailsFromExif } from "./photo-details.js";
import sharp from "sharp";
import type { PhotoMetadata } from "@lifeos/core";

/** Bounded TIFF/EXIF inspection. Only return confidence; do not copy private tags. */
export function cameraEvidenceFromExif(exif: Uint8Array | undefined): PhotoMetadata["cameraEvidence"] {
  if (exif === undefined || exif.length < 8 || exif.length > 256 * 1024) return "none";
  try {
    const start = exif[0] === 0x45 && exif[1] === 0x78 && exif[2] === 0x69 && exif[3] === 0x66 && exif[4] === 0 && exif[5] === 0 ? 6 : 0;
    const view = new DataView(exif.buffer, exif.byteOffset + start, exif.byteLength - start);
    const little = view.getUint16(0) === 0x4949;
    if (!little && view.getUint16(0) !== 0x4d4d) return "none";
    if (view.getUint16(2, little) !== 42) return "none";
    let make = false;
    let model = false;
    const capture = new Set<number>();
    const visited = new Set<number>();
    const inspect = (offset: number, depth: number): void => {
      if (depth > 1 || offset < 8 || offset + 2 > view.byteLength || visited.has(offset)) return;
      visited.add(offset);
      const count = Math.min(view.getUint16(offset, little), 64);
      for (let i = 0; i < count; i += 1) {
        const at = offset + 2 + i * 12;
        if (at + 12 > view.byteLength) break;
        const tag = view.getUint16(at, little);
        const type = view.getUint16(at + 2, little);
        const units = view.getUint32(at + 4, little);
        if (tag === 0x8769 && type === 4 && units === 1) {
          inspect(view.getUint32(at + 8, little), depth + 1);
          continue;
        }
        if ((tag === 0x10f || tag === 0x110 || tag === 0x9003) && type === 2 && units > 1 && units <= 128) {
          const pos = units <= 4 ? at + 8 : view.getUint32(at + 8, little);
          if (pos < 8 || pos + units > view.byteLength) continue;
          const text = new TextDecoder().decode(exif.subarray(start + pos, start + pos + units)).replace(/\0/g, "").trim();
          if (tag === 0x10f) make = text.length > 0;
          if (tag === 0x110) model = text.length > 0;
          if (tag === 0x9003 && /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) capture.add(tag);
        }
        if ([0x829a, 0x829d, 0x920a].includes(tag) && type === 5 && units === 1) {
          const pos = view.getUint32(at + 8, little);
          if (pos >= 8 && pos + 8 <= view.byteLength && view.getUint32(pos, little) > 0 && view.getUint32(pos + 4, little) > 0) capture.add(tag);
        }
        if (tag === 0x8827 && type === 3 && units === 1 && view.getUint16(at + 8, little) > 0) capture.add(tag);
      }
    };
    inspect(view.getUint32(4, little), 0);
    return make && model ? (capture.size >= 2 ? "capture" : "device") : "none";
  } catch {
    return "none";
  }
}

/** Reads headers from bytes already uploaded; no decode, extra request or upload failure. */
export async function readPhotoMetadata(bytes: Buffer | string): Promise<PhotoMetadata | undefined> {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata();
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    if (width === undefined || height === undefined || width < 1 || height < 1 || width > 100_000 || height > 100_000) return undefined;
    const details = photoDetailsFromExif(metadata.exif);
    return { version: 1, width, height, cameraEvidence: cameraEvidenceFromExif(metadata.exif), detailsVersion: 1, ...(details === undefined ? {} : { details }) };
  } catch {
    return undefined;
  }
}

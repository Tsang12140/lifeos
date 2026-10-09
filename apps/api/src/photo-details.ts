import type { PhotoDetails } from "@lifeos/core";

/** Whitelisted TIFF tags only; offsets/counts are bounded before every read.
 * MakerNotes, thumbnails and arbitrary binary blobs never become UI text. */
export function photoDetailsFromExif(exif: Uint8Array | undefined): PhotoDetails | undefined {
  if (!exif || exif.length < 8 || exif.length > 256 * 1024) return undefined;
  try {
    const start = exif[0] === 69 && exif[1] === 120 && exif[2] === 105 && exif[3] === 102 && exif[4] === 0 && exif[5] === 0 ? 6 : 0;
    const bytes = exif.subarray(start), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = view.getUint16(0) === 0x4949;
    if ((!little && view.getUint16(0) !== 0x4d4d) || view.getUint16(2, little) !== 42) return undefined;
    const fields = new Map<string, string | readonly number[]>(), visited = new Set<number>();
    const walk = (offset: number, group: string, depth: number): void => {
      if (depth > 3 || offset < 8 || offset + 2 > bytes.length || visited.has(offset)) return;
      visited.add(offset);
      const count = Math.min(view.getUint16(offset, little), 128);
      for (let i = 0; i < count; i++) {
        const at = offset + 2 + i * 12;
        if (at + 12 > bytes.length) break;
        const tag = view.getUint16(at, little), type = view.getUint16(at + 2, little), units = view.getUint32(at + 4, little);
        const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 9: 4, 10: 8 } as Record<number, number>)[type];
        if (!size || units < 1 || units > 1024) continue;
        const length = size * units, pos = length <= 4 ? at + 8 : view.getUint32(at + 8, little);
        if (pos < 8 || pos + length > bytes.length) continue;
        if (type === 4 && units === 1 && (tag === 0x8769 || tag === 0x8825)) { walk(view.getUint32(pos, little), tag === 0x8825 ? "gps" : "exif", depth + 1); continue; }
        if (type === 2) {
          const text = new TextDecoder().decode(bytes.subarray(pos, pos + length)).replace(/[\u0000-\u001f\u007f]/gu, "").trim();
          if (text) fields.set(`${group}:${tag}`, Array.from(text).slice(0, 256).join(""));
        } else if (units <= 4) {
          const values: number[] = [];
          for (let n = 0; n < units; n++) {
            const p = pos + n * size;
            const value = type === 1 ? view.getUint8(p) : type === 3 ? view.getUint16(p, little) : type === 4 ? view.getUint32(p, little) : type === 9 ? view.getInt32(p, little) : type === 5 ? view.getUint32(p, little) / view.getUint32(p + 4, little) : view.getInt32(p, little) / view.getInt32(p + 4, little);
            if (Number.isFinite(value)) values.push(value);
          }
          if (values.length === units) fields.set(`${group}:${tag}`, values);
        }
      }
    };
    walk(view.getUint32(4, little), "ifd", 0);
    const text = (group: string, tag: number) => { const value = fields.get(`${group}:${tag}`); return typeof value === "string" ? value : undefined; };
    const nums = (group: string, tag: number) => { const value = fields.get(`${group}:${tag}`); return Array.isArray(value) ? value as number[] : undefined; };
    const details: Record<string, string | number> = {};
    for (const [key, group, tag] of [["make", "ifd", 0x10f], ["model", "ifd", 0x110], ["lens", "exif", 0xa434], ["capturedAt", "exif", 0x9003], ["timeZoneOffset", "exif", 0x9011], ["software", "ifd", 0x131], ["artist", "ifd", 0x13b], ["copyright", "ifd", 0x8298], ["description", "ifd", 0x10e]] as const) {
      const value = text(group, tag); if (value) details[key] = value;
    }
    if (typeof details.capturedAt === "string" && !/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/u.test(details.capturedAt)) delete details.capturedAt;
    if (typeof details.timeZoneOffset === "string" && !/^[+-](?:0\d|1[0-4]):[0-5]\d$/u.test(details.timeZoneOffset)) delete details.timeZoneOffset;
    for (const [key, tag] of [["exposureSeconds", 0x829a], ["aperture", 0x829d], ["focalLength", 0x920a], ["iso", 0x8827], ["exposureBias", 0x9204], ["flash", 0x9209], ["whiteBalance", 0xa403]] as const) {
      const value = nums("exif", tag)?.[0]; if (value !== undefined && (key === "exposureBias" || value >= 0)) details[key] = value;
    }
    const coord = (tag: number, refTag: number, positive: string, negative: string, limit: number) => {
      const value = nums("gps", tag), ref = text("gps", refTag);
      if (!value || value.length !== 3 || (ref !== positive && ref !== negative) || value[0]! < 0 || value[1]! < 0 || value[1]! >= 60 || value[2]! < 0 || value[2]! >= 60) return undefined;
      const result = (value[0]! + value[1]! / 60 + value[2]! / 3600) * (ref === negative ? -1 : 1);
      return Math.abs(result) <= limit ? result : undefined;
    };
    const latitude = coord(2, 1, "N", "S", 90), longitude = coord(4, 3, "E", "W", 180);
    if (latitude !== undefined && longitude !== undefined) { details.latitude = latitude; details.longitude = longitude; }
    const altitude = nums("gps", 6)?.[0], altitudeRef = nums("gps", 5)?.[0];
    if (altitude !== undefined && (altitudeRef === 0 || altitudeRef === 1)) details.altitude = altitude * (altitudeRef === 1 ? -1 : 1);
    return Object.keys(details).length === 0 ? undefined : details as PhotoDetails;
  } catch { return undefined; }
}

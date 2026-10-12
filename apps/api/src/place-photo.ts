import https from "node:https";
import dns from "node:dns/promises";
import type { Entity } from "@lifeos/core";
import { publicIpv4 } from "./amap-location.js";
import { baseMediaType } from "./asset-static.js";
import { storeAssetBytes } from "./routes-assets.js";
import type { RouteContext } from "./route-context.js";

// Only provider-owned photo hosts, never arbitrary URLs or redirects. Pin the
// resolved public address while preserving the hostname for TLS verification.
export function placePhotoUrl(value: string): URL {
  const url = new URL(value);
  if (value.length > 4096 || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !["store.is.autonavi.com", "aos-comment.amap.com"].includes(url.hostname)) throw new Error("unsupported_photo_host");
  return url;
}

export async function downloadPlacePhoto(value: string): Promise<{ bytes: Buffer; mediaType: string }> {
  const url = placePhotoUrl(value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const addresses = await Promise.race([
      dns.lookup(url.hostname, { all: true, family: 4 }),
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("photo_timeout")), { once: true })),
    ]);
    if (!addresses.length || addresses.some(item => !publicIpv4(item.address))) throw new Error("private_photo_address");
    const address = addresses[0]!.address;
    return await new Promise((resolve, reject) => {
      const request = https.get(url, {
        agent: false, family: 4, signal: controller.signal,
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
      }, response => {
        const fail = (reason: string) => { response.destroy(); reject(new Error(reason)); };
        if (response.statusCode !== 200) { fail("photo_http_failed"); return; }
        const mediaType = baseMediaType(response.headers["content-type"]);
        if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(mediaType)) { fail("photo_type_invalid"); return; }
        const limit = 2 * 1024 * 1024;
        if (Number(response.headers["content-length"]) > limit) { fail("photo_too_large"); return; }
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > limit) fail("photo_too_large"); else chunks.push(chunk); });
        response.on("end", () => resolve({ bytes: Buffer.concat(chunks), mediaType }));
        response.on("error", reject);
      });
      request.on("error", reject);
    });
  } finally { clearTimeout(timer); }
}

// Injectable transport lets isolated tests exercise the real storage pipeline.
export const placePhotoTransport = { download: downloadPlacePhoto };
const pending = new Map<string, Promise<Entity>>();
export function ensurePlacePhoto(ctx: RouteContext, id: string): Promise<Entity> {
  const key = `${ctx.config.dataDirectory}|${id}`;
  const active = pending.get(key);
  if (active) return active;
  const work = (async () => {
    const place = ctx.repository.findEntityById(id);
    if (!place) throw new Error("place_not_found");
    if (place.type !== "place" || place.avatarAssetId || !place.amapId || !place.photoUrl) return place;
    try {
      placePhotoUrl(place.photoUrl);
      const image = await placePhotoTransport.download(place.photoUrl);
      const asset = await storeAssetBytes(ctx, image.bytes, image.mediaType, { purpose: "avatar" });
      const latest = ctx.repository.findEntityById(id);
      // A custom upload, removal or edit made during download takes precedence.
      if (!latest || latest.type !== "place" || latest.avatarAssetId || latest.photoUrl !== place.photoUrl || latest.amapId !== place.amapId) return latest ?? place;
      const updated = { ...latest, avatarAssetId: asset.id };
      ctx.repository.updateEntity(updated);
      return updated;
    } catch (error) {
      const code = error instanceof Error ? (/^[a-z_]{1,40}$/.test(error.message) ? error.message : error.name) : "unknown";
      console.warn(JSON.stringify({ event: "place_photo_import_failed", placeId: id, code }));
      return ctx.repository.findEntityById(id) ?? place;
    }
  })();
  pending.set(key, work);
  void work.finally(() => { if (pending.get(key) === work) pending.delete(key); }).catch(() => {});
  return work;
}

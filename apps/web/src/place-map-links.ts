export type MapPlatform = "ios" | "android" | "desktop";
export interface MapPlace { name: string; address?: string; city?: string; longitude?: number; latitude?: number }
export function mapPlatform(userAgent: string, touchPoints = 0): MapPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return "ios";
  return /Android/i.test(userAgent) ? "android" : "desktop";
}
const link = (base: string, fields: Record<string, string>) => `${base}?${new URLSearchParams(fields)}`;
export function placeMapLinks(place: MapPlace, platform: MapPlatform) {
  const hasPoint = Number.isFinite(place.longitude) && Number.isFinite(place.latitude) && Math.abs(place.longitude!) <= 180 && Math.abs(place.latitude!) <= 90;
  const address = [place.city, place.address || place.name].filter(Boolean).join(" ");
  const amapBase = hasPoint ? "https://uri.amap.com/marker" : "https://uri.amap.com/search";
  const amap: Record<string, string> = hasPoint ? { position: `${place.longitude},${place.latitude}`, name: place.name, coordinate: "gaode", src: "LifeOS" } : { keyword: address, city: place.city ?? "", src: "LifeOS" };
  const baiduFields: Record<string, string> = hasPoint ? { location: `${place.latitude},${place.longitude}`, title: place.name, content: place.address || place.name, coord_type: "gcj02" } : { address };
  const baiduPath = hasPoint ? "marker" : "geocoder";
  const baiduWeb = link(`https://api.map.baidu.com/${baiduPath}`, { ...baiduFields, output: "html", src: "webapp.lifeos.web" });
  return [
    { id: "amap", name: "高德地图", href: link(amapBase, { ...amap, callnative: platform === "desktop" ? "0" : "1" }), web: link(amapBase, { ...amap, callnative: "0" }) },
    { id: "baidu", name: "百度地图", href: platform === "desktop" ? baiduWeb : link(`${platform === "ios" ? "baidumap" : "bdapp"}://map/${baiduPath}`, { ...baiduFields, src: `${platform === "ios" ? "ios" : "andr"}.lifeos.web` }), web: baiduWeb },
  ];
}

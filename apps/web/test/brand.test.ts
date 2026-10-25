import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url);

test("the selected LifeOS mark and home-screen icons share one public icon family", () => {
  const favicon = readFileSync(publicFile("favicon.svg"), "utf8");
  assert.match(favicon, /viewBox="0 0 64 64"/);
  assert.match(favicon, /<rect[^>]+rx="16"[^>]+fill="#4D5869"/);
  assert.match(favicon, /fill="#E3D3AE"/);
  assert.equal((favicon.match(/stroke="#F1ECDB" stroke-width="3.5"/g) ?? []).length, 2);

  const maskable = readFileSync(publicFile("icon-maskable.svg"), "utf8");
  assert.match(maskable, /<rect width="64" height="64" fill="#4D5869"/);
  assert.match(maskable, /scale\(0\.85\)/);

  const manifest = JSON.parse(readFileSync(publicFile("site.webmanifest"), "utf8")) as {
    name: string;
    display: string;
    theme_color: string;
    icons: Array<{ src: string; sizes: string; purpose: string }>;
  };
  assert.equal(manifest.name, "LifeOS");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#eef2f7");
  assert.deepEqual(manifest.icons.map(({ sizes, purpose }) => `${sizes}:${purpose}`), ["192x192:any", "512x512:any", "512x512:maskable"]);

  for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512], ["icon-maskable-512.png", 512]] as const) {
    const png = readFileSync(publicFile(name));
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${name} PNG signature`);
    assert.equal(png.readUInt32BE(16), size, `${name} width`);
    assert.equal(png.readUInt32BE(20), size, `${name} height`);
  }
});

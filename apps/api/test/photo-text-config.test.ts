import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApiConfig } from "../src/config.js";
import {
  isPhotoTextCapabilityEnabled,
  photoTextStatus,
  readRuntimePhotoTextConfig,
  saveRuntimePhotoTextConfig,
} from "../src/photo-text-config.js";

/**
 * The switches are the owner's permission; readiness is the machine's ability. These tests
 * cover both, and above all the case that matters most: **no file at all must mean "both
 * on"**. The feature shipped before the switches did, so anything else would switch off
 * every existing library the moment this landed.
 */

function makeConfig(root: string, overrides: Record<string, unknown> = {}): ApiConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(root, "lifeos.sqlite"),
    dataDirectory: root,
    webDirectory: join(root, "web"),
    allowedOrigins: [],
    cookieSecure: false,
    bodyLimitBytes: 1024 * 1024,
    assetUploadLimitBytes: 1024,
    assetOrphanGraceDays: 7,
    assetTrashDays: 30,
    deepseekModel: "deepseek-flash",
    deepseekBaseUrl: "https://api.deepseek.com",
    qweatherHost: "devapi.qweather.com",
    assetRoot: join(root, "assets"),
    ...overrides,
  } as unknown as ApiConfig;
}

const OCR_CREDENTIALS = { secretId: "id", secretKey: "key", region: "ap-guangzhou", actions: "GeneralAccurateOCR" };

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "lifeos-photo-text-config-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

test("with no file at all both capabilities are on, so an existing library keeps working", () => {
  withTempRoot((root) => {
    const config = makeConfig(root);
    assert.deepEqual(readRuntimePhotoTextConfig(config), { caption: true, ocr: true, source: "default" });
    assert.equal(isPhotoTextCapabilityEnabled(config, "caption"), true);
    assert.equal(isPhotoTextCapabilityEnabled(config, "ocr"), true);
  });
});

test("a corrupt file is ignored rather than read as 'everything off'", () => {
  withTempRoot((root) => {
    const config = makeConfig(root);
    writeFileSync(join(root, "photo-text-config.json"), "{ not json", "utf8");
    assert.equal(readRuntimePhotoTextConfig(config).source, "default");
    assert.equal(isPhotoTextCapabilityEnabled(config, "ocr"), true);

    // Half-written is the same as unreadable: a missing key is not a false.
    writeFileSync(join(root, "photo-text-config.json"), JSON.stringify({ ocr: false }), "utf8");
    assert.equal(readRuntimePhotoTextConfig(config).source, "default");
    assert.equal(isPhotoTextCapabilityEnabled(config, "ocr"), true);
  });
});

test("each switch saves on its own and never disturbs the other", () => {
  withTempRoot((root) => {
    const config = makeConfig(root);

    saveRuntimePhotoTextConfig(config, { ocr: false });
    assert.deepEqual(readRuntimePhotoTextConfig(config), { caption: true, ocr: false, source: "file" });

    saveRuntimePhotoTextConfig(config, { caption: false });
    assert.deepEqual(readRuntimePhotoTextConfig(config), { caption: false, ocr: false, source: "file" });

    saveRuntimePhotoTextConfig(config, { ocr: true });
    assert.deepEqual(readRuntimePhotoTextConfig(config), { caption: false, ocr: true, source: "file" });
  });
});

test("saving returns the status of both capabilities, so the panel needs one round trip", () => {
  withTempRoot((root) => {
    const config = makeConfig(root, { tencentOcr: OCR_CREDENTIALS, deepseekApiKey: "sk-test" });
    const status = saveRuntimePhotoTextConfig(config, { ocr: false });
    assert.equal(status.ocr.enabled, false);
    assert.equal(status.ocr.state, "switched-off");
    assert.equal(status.caption.enabled, true);
    assert.equal(status.caption.state, "ready");
  });
});

test("a switched-off capability reads as off even when it also has no credential", () => {
  withTempRoot((root) => {
    const config = makeConfig(root);
    saveRuntimePhotoTextConfig(config, { ocr: false, caption: false });
    const status = photoTextStatus(config);
    // "Off" is the actionable truth; "no key" would send her hunting for a credential to
    // fix something she stopped on purpose.
    assert.equal(status.ocr.state, "switched-off");
    assert.equal(status.ocr.credentials, false);
    assert.equal(status.caption.state, "switched-off");
    assert.equal(status.caption.available, false);
  });
});

test("on but unusable reads as a missing credential, and says so for the right capability", () => {
  withTempRoot((root) => {
    // OCR key present, AI key absent — the two must not be confused for one another.
    const config = makeConfig(root, { tencentOcr: OCR_CREDENTIALS });
    const status = photoTextStatus(config);
    assert.deepEqual(
      { enabled: status.ocr.enabled, credentials: status.ocr.credentials, state: status.ocr.state, available: status.ocr.available },
      { enabled: true, credentials: true, state: "ready", available: true },
    );
    assert.equal(status.caption.state, "no-credential");
    assert.equal(status.caption.available, false);
  });
});

test("an AI key with the AI module switched off does not count as usable", () => {
  withTempRoot((root) => {
    const config = makeConfig(root, { deepseekApiKey: "sk-test" });
    writeFileSync(
      join(root, "ai-config.json"),
      JSON.stringify({ enabled: false, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" }),
      "utf8",
    );
    const status = photoTextStatus(config);
    // The key is still on disk, but a module that is switched off cannot place a call.
    assert.equal(status.caption.state, "no-credential");
    assert.equal(isPhotoTextCapabilityEnabled(config, "caption"), true);
  });
});

import { createHash, createHmac } from "node:crypto";

/**
 * Tencent Cloud OCR — the "read the actual words in the picture" half of the photo pass.
 *
 * The AI pass answers *what is this a photo of*; this one answers *what does it say*.
 * They are not substitutes: a caption summarises and drops detail ("一本摊开的书"),
 * while OCR copies the words verbatim — which is exactly what a page of a book, a
 * menu, a receipt or a shop sign needs. Neither sees the other's case: a photo with
 * no text at all (a cat, a bowl of rice) has nothing for OCR to read, and a wall of
 * small print is where a vision model mis-reads characters it would have to spell out.
 *
 * Three things shape this module:
 *
 *   · **No SDK.** The request is signed by hand with `node:crypto` (four steps,
 *     documented below). An SDK would be one more dependency in a process that also
 *     serves photos, and the signing is a pure function that a test can pin against
 *     the values in Tencent's own documentation.
 *   · **Format matters.** The API documents PNG / JPG / JPEG / BMP / PDF and does not
 *     list WebP — and every derived thumbnail in this project *is* WebP. So the caller
 *     hands over bytes and the caller is responsible for the format; we refuse rather
 *     than send something the service may silently mishandle.
 *   · **Reading a picture and failing to reach the service are different answers.**
 *     An error path used to collapse them into `null`, which is not enough to act on:
 *     a refusal, a timeout or a spent package is `unread` and is never written down,
 *     while a picture the service read and found wordless is `blank` — and that one is
 *     worth remembering, as an empty marker that stops the next pass paying for it.
 */

/** Fixed by the service: host, the `service` segment of the credential scope, and the API version. */
export const TENCENT_OCR_HOST = "ocr.tencentcloudapi.com";
export const TENCENT_OCR_SERVICE = "ocr";
export const TENCENT_OCR_VERSION = "2018-11-19";

/**
 * Both actions carry their **own** 1000-call/month free package — separate package names,
 * so they do not share — which means comparing the two side by side is itself free.
 * They differ once the free tier is spent (0.15 vs 0.50 CNY per call) and in accuracy:
 * `GeneralAccurateOCR` reads small, tilted and blurry text markedly better (99% vs 96%
 * claimed). The owner picks per deployment through `LIFEOS_TENCENT_OCR_ACTION`; Basic is
 * the default so a first pass costs nothing.
 */
export const TENCENT_OCR_ACTIONS = ["GeneralBasicOCR", "GeneralAccurateOCR"] as const;
export type TencentOcrAction = (typeof TENCENT_OCR_ACTIONS)[number];
export const DEFAULT_TENCENT_OCR_ACTION: TencentOcrAction = "GeneralBasicOCR";

/** Domestic regions only. A region outside the Chinese mainland bills on the international
 *  price list and does not draw on a domestic resource package (Tencent's own docs). */
export const DEFAULT_TENCENT_OCR_REGION = "ap-guangzhou";

/** The service refuses a Base64 payload above this. Our 2048px JPEGs are ~1 MB, far under it. */
export const TENCENT_OCR_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Longest edge below this and small print stops resolving; the service recommends 600×800. */
export const TENCENT_OCR_MIN_EDGE = 600;

export interface TencentOcrCredentials {
  readonly secretId: string;
  readonly secretKey: string;
  readonly region: string;
  readonly action: TencentOcrAction;
}

/** Reads the action name off configuration, falling back to the free-tier safe default. */
export function parseTencentOcrAction(raw: string | undefined): TencentOcrAction {
  return (TENCENT_OCR_ACTIONS as readonly string[]).includes(raw ?? "") ? (raw as TencentOcrAction) : DEFAULT_TENCENT_OCR_ACTION;
}

function sha256Hex(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function hmac(key: string | Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/** `YYYY-MM-DD` in UTC — the date the credential scope is derived from. */
export function tencentSignatureDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** One header that takes part in the signature. Names must already be lower-case. */
export interface TencentSignedHeader {
  readonly name: string;
  readonly value: string;
}

/** The headers signed at runtime: exactly the pair Tencent's own SDK signs. */
function runtimeSignedHeaders(host: string): readonly TencentSignedHeader[] {
  return [
    { name: "content-type", value: "application/json; charset=utf-8" },
    { name: "host", value: host },
  ];
}

/**
 * Step 1 — the canonical request. Exported because this is the step that is easy to get
 * subtly wrong (a missing blank line, headers out of order) and the step whose hash
 * Tencent publishes in its signing document, so a test can hold it to the published value
 * without ever knowing a secret key.
 */
export function buildTencentCanonicalRequest(input: {
  readonly host: string;
  readonly payload: string;
  readonly extraSignedHeaders?: readonly TencentSignedHeader[];
}): string {
  const headers = [...runtimeSignedHeaders(input.host), ...(input.extraSignedHeaders ?? [])];
  const signedHeaders = headers.map((header) => header.name).join(";");
  const canonicalHeaders = headers.map((header) => `${header.name}:${header.value}\n`).join("");
  return ["POST", "/", "", canonicalHeaders, signedHeaders, sha256Hex(input.payload)].join("\n");
}

/** Step 2 — the string to sign. Also published, also assertable. */
export function buildTencentStringToSign(input: {
  readonly canonicalRequest: string;
  readonly timestamp: number;
  readonly service: string;
}): string {
  const credentialScope = `${tencentSignatureDate(input.timestamp)}/${input.service}/tc3_request`;
  return ["TC3-HMAC-SHA256", String(input.timestamp), credentialScope, sha256Hex(input.canonicalRequest)].join("\n");
}

/**
 * The four documented steps of TC3-HMAC-SHA256, in one place and free of I/O.
 *   1. canonical request — method, path, query, the signed headers, and the body hash;
 *   2. string to sign — algorithm, timestamp, credential scope, and the hash of step 1;
 *   3. signing key — HMAC chain `TC3+key → date → service → "tc3_request"`;
 *   4. Authorization header — credential scope plus the final signature.
 *
 * Only the headers listed in `SignedHeaders` are signed, and the service verifies exactly
 * those — so the runtime call signs `content-type;host`, while `extraSignedHeaders` lets a
 * test reproduce the documented example, which signs `x-tc-action` as well.
 */
export function signTencentRequest(input: {
  readonly secretId: string;
  readonly secretKey: string;
  readonly host: string;
  readonly service: string;
  readonly timestamp: number;
  readonly payload: string;
  readonly extraSignedHeaders?: readonly TencentSignedHeader[];
}): string {
  const { secretId, secretKey, host, service, timestamp, payload } = input;
  const canonicalRequest = buildTencentCanonicalRequest({ host, payload, ...(input.extraSignedHeaders === undefined ? {} : { extraSignedHeaders: input.extraSignedHeaders }) });
  const stringToSign = buildTencentStringToSign({ canonicalRequest, timestamp, service });
  const signature = createHmac("sha256", hmac(hmac(hmac(`TC3${secretKey}`, tencentSignatureDate(timestamp)), service), "tc3_request"))
    .update(stringToSign, "utf8")
    .digest("hex");
  const signedHeaders = [...runtimeSignedHeaders(host), ...(input.extraSignedHeaders ?? [])].map((header) => header.name).join(";");
  const credentialScope = `${tencentSignatureDate(timestamp)}/${service}/tc3_request`;
  return `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** One recognised line, in the order the service returned it. */
interface OcrTextDetection {
  readonly DetectedText?: unknown;
}

export interface TencentOcrResponse {
  readonly Response?: {
    readonly TextDetections?: readonly OcrTextDetection[];
    readonly RequestId?: unknown;
    readonly Error?: { readonly Code?: unknown; readonly Message?: unknown };
  };
}

/**
 * Lines joined by newlines, blanks dropped, hard-capped. Newline (not space) because the
 * service's line breaks carry layout meaning — a receipt's two columns must not be spliced
 * into one phrase. The cap stops a dense page from turning into kilobytes of derived text;
 * search matches on substrings, so the head of the page is what anyone would search for.
 */
export const OCR_TEXT_MAX_CHARS = 4000;

export function ocrTextFromResponse(body: TencentOcrResponse): string {
  const detections = body.Response?.TextDetections;
  if (!Array.isArray(detections)) return "";
  const lines: string[] = [];
  for (const detection of detections) {
    const text = typeof detection?.DetectedText === "string" ? detection.DetectedText.trim() : "";
    if (text !== "") lines.push(text);
  }
  return lines.join("\n").slice(0, OCR_TEXT_MAX_CHARS);
}

/** The error the service reported, or undefined when the call succeeded. */
export function ocrErrorFromResponse(body: TencentOcrResponse): string | undefined {
  const error = body.Response?.Error;
  if (error === undefined) return undefined;
  const code = typeof error.Code === "string" ? error.Code : "Unknown";
  const message = typeof error.Message === "string" ? error.Message : "";
  return `${code}${message === "" ? "" : `: ${message}`}`;
}

/**
 * The code the service uses for "there are no words in this picture". It is an *answer*,
 * not a fault: the call succeeded at its job. Kept as a constant because the downgrade
 * chain (§11) treats it as the one error that must never move on to the next tier.
 */
export const TENCENT_OCR_NO_TEXT_CODE = "FailedOperation.ImageNoText";

/** Local failure codes, namespaced so they can never collide with a service error code. */
export const LOCAL_OCR_IMAGE_UNUSABLE = "Local.ImageUnusable";
export const LOCAL_OCR_NETWORK = "Local.NetworkError";

/**
 * What one call actually produced.
 *
 * This used to be folded into `string | null`, which is enough to *store* words but not
 * enough to decide what to do next: a picture with nothing to read and an exhausted
 * resource package both arrived as `null`, yet one means "no other engine can do better
 * here" and the other means "the next engine should try". The chain needs them apart, so
 * the probe hands back the code as well.
 */
export type TencentOcrOutcome =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "notext" }
  | { readonly kind: "failure"; readonly code: string; readonly message: string };

/**
 * What one recogniser call produced. Three answers rather than two, because the pass has
 * to react differently to "there is nothing to read here" and "I never got to look":
 *
 *   · `text`   — the words, plus which engine read them (that name lands in the entry's
 *                `model`, so a later reader can tell a preferred engine from a fallback);
 *   · `blank`  — the picture *was* read and it has no words. A finished answer, and the
 *                one case where the pass may file an **empty marker** so the next run
 *                skips this photo instead of paying for the same nothing again;
 *   · `unread` — nothing was read at all: a rate limit, a timeout, a spent package, no
 *                credentials, an unreadable payload. **Nothing may be filed**, or one bad
 *                minute would mark the whole library "no words here" for good.
 *
 * That last distinction is the whole reason this is not `string | null` any more: with a
 * boolean "did it answer", a network blip and a wordless cat look identical, and one of
 * them is permanent if written down.
 *
 * Injected in tests, and swappable later for the local tesseract fallback (plan §6).
 */
export type PhotoTextOutcome =
  | { readonly kind: "text"; readonly text: string; readonly engine: string }
  | { readonly kind: "blank"; readonly engine: string }
  | { readonly kind: "unread" };

export type PhotoTextRecognizer = (input: { readonly image: Buffer; readonly mime: "image/jpeg" | "image/png" }) => Promise<PhotoTextOutcome>;

/** Turns a base64 string into a Buffer, or null when the payload is unusable. */
function decodeBase64Image(image: Buffer): string | null {
  if (image.length === 0) return null;
  // The service measures the *encoded* size; anything above the cap is refused before
  // it is sent, because some failures still bill (Tencent's own documentation).
  if (image.length * 4 / 3 > TENCENT_OCR_MAX_IMAGE_BYTES) return null;
  return image.toString("base64");
}

/**
 * One call to one action, reported in full. Never throws: a refused request, a dead
 * network and an empty picture all come back as an outcome, because a single unlucky
 * photo must not end the pass.
 */
export function createTencentOcrProbe(
  credentials: TencentOcrCredentials,
  fetchImpl: typeof fetch = fetch,
): (input: { readonly image: Buffer }) => Promise<TencentOcrOutcome> {
  return async ({ image }) => {
    const encoded = decodeBase64Image(image);
    if (encoded === null) return { kind: "failure", code: LOCAL_OCR_IMAGE_UNUSABLE, message: "图片为空或超过服务的 10MB 上限" };
    const payload = JSON.stringify({ ImageBase64: encoded });
    const timestamp = Math.floor(Date.now() / 1000);
    const authorization = signTencentRequest({
      secretId: credentials.secretId,
      secretKey: credentials.secretKey,
      host: TENCENT_OCR_HOST,
      service: TENCENT_OCR_SERVICE,
      timestamp,
      payload,
    });
    let response: Response;
    try {
      response = await fetchImpl(`https://${TENCENT_OCR_HOST}`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json; charset=utf-8",
          host: TENCENT_OCR_HOST,
          "x-tc-action": credentials.action,
          "x-tc-timestamp": String(timestamp),
          "x-tc-version": TENCENT_OCR_VERSION,
          "x-tc-region": credentials.region,
        },
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      return { kind: "failure", code: LOCAL_OCR_NETWORK, message: error instanceof Error ? error.message : "网络请求失败" };
    }
    let body: TencentOcrResponse;
    try {
      body = (await response.json()) as TencentOcrResponse;
    } catch {
      return { kind: "failure", code: LOCAL_OCR_NETWORK, message: `响应不是 JSON（HTTP ${response.status}）` };
    }
    const error = body.Response?.Error;
    if (error !== undefined) {
      const code = typeof error.Code === "string" ? error.Code : "Unknown";
      const message = typeof error.Message === "string" ? error.Message : "";
      // "No words here" arrives as an error code but is a finished answer.
      if (code === TENCENT_OCR_NO_TEXT_CODE) return { kind: "notext" };
      return { kind: "failure", code, message };
    }
    if (!response.ok) return { kind: "failure", code: `Http.${response.status}`, message: "服务返回非 2xx" };
    const text = ocrTextFromResponse(body);
    return text === "" ? { kind: "notext" } : { kind: "text", text };
  };
}

/**
 * A recogniser bound to one action — no chain. Used by deployments that configured a
 * single tier, and by tests that want one engine's answer.
 */
export function createTencentOcrRecognizer(credentials: TencentOcrCredentials, fetchImpl: typeof fetch = fetch): PhotoTextRecognizer {
  const probe = createTencentOcrProbe(credentials, fetchImpl);
  return async ({ image }) => {
    const outcome = await probe({ image });
    if (outcome.kind === "text") return { kind: "text", text: outcome.text, engine: credentials.action };
    if (outcome.kind === "notext") return { kind: "blank", engine: credentials.action };
    // Everything else — a refusal, a timeout, a picture the service would not decode —
    // is "this photo was not read", which must never be written down as "no words here".
    return { kind: "unread" };
  };
}

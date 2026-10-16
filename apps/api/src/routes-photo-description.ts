import { setJson, HttpError } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { booleanField, hasOnlyKeys, jsonObject } from "./field-validate.js";
import { PHOTO_DESCRIPTION_VARIANTS, capabilityFor, describePhotoLibrary, type PhotoDescriptionVariant } from "./photo-description.js";
import { isPhotoTextCapabilityEnabled, photoTextStatus, saveRuntimePhotoTextConfig, type PhotoTextCapability } from "./photo-text-config.js";
import type { RouteHandler } from "./route-context.js";

/** How a capability is named to the owner. The internal names are the code's, not hers. */
const CAPABILITY_LABELS: Readonly<Record<PhotoTextCapability, string>> = {
  caption: "AI 识别",
  ocr: "照片文字识别",
};

/**
 * `POST /api/ai/photo-description` — read the photos this library already holds and
 * file one line about each, so a picture the owner never wrote about is still findable.
 *
 * Deliberately not on a clock: nothing here arms itself at an hour. What does run by itself
 * is the **OCR** pass, and not on a schedule either — saving an entry that carries photos
 * nudges it, behind the request (see `PhotoTextTrigger`). The captioning passes stay manual,
 * because they bill per picture and that decision belongs to the owner.
 *
 * `GET` reports what a pass *would* do — how many photos there are, how many already
 * have a line — without reading a single picture or calling the model. It keeps answering
 * even for a capability that is switched off, because "how much is left to read" is exactly
 * what the owner wants to know before deciding whether to switch it back on.
 *
 * `GET|POST /api/ai/photo-description/config` carries the two switches and their readiness.
 */
export const handlePhotoDescriptionRoutes: RouteHandler = async (ctx, req, res, pathname, url) => {
  const isConfigPath = pathname === "/api/ai/photo-description/config";
  if (!isConfigPath && pathname !== "/api/ai/photo-description") return false;
  const { config, repository, thumbnails } = ctx;

  // The two switches, and whether this machine could carry each of them out. On the same
  // path as the pass because they are one subject: what this library does with pictures,
  // and what it is allowed to do with them.
  if (isConfigPath) {
    if (req.method === "GET") {
      setJson(res, 200, photoTextStatus(config));
      return true;
    }
    if (req.method === "POST") {
      requireJsonContentType(req, true);
      const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
      hasOnlyKeys(input, ["caption", "ocr"]);
      // Each switch is optional and saved on its own, so toggling one can never disturb the
      // other — the panel writes only what she touched.
      setJson(res, 200, saveRuntimePhotoTextConfig(config, {
        ...(input.caption === undefined ? {} : { caption: booleanField(input.caption, "caption") }),
        ...(input.ocr === undefined ? {} : { ocr: booleanField(input.ocr, "ocr") }),
      }));
      return true;
    }
    return false;
  }

  if (req.method === "GET") {
    // The same read-only survey serves as the settings panel's counter, so it answers for
    // whichever pass is asked about. `plain` stays the default: the endpoint's first
    // caller asked about captions, and moving that number under it unannounced would make
    // an old reading mean something new.
    const requested = url.searchParams.get("variant");
    let surveyVariant: PhotoDescriptionVariant = "plain";
    if (requested !== null) {
      if (!(PHOTO_DESCRIPTION_VARIANTS as readonly string[]).includes(requested)) {
        throw new HttpError(400, "invalid_variant", `variant 必须是 ${PHOTO_DESCRIPTION_VARIANTS.join(" / ")}`);
      }
      surveyVariant = requested as PhotoDescriptionVariant;
    }
    setJson(res, 200, await describePhotoLibrary({ repository, config, thumbnails, limit: 0, dryRun: true, variant: surveyVariant }));
    return true;
  }
  if (req.method !== "POST") return false;

  requireJsonContentType(req, true);
  const input = jsonObject(await readBody(req, config.bodyLimitBytes), "body");
  hasOnlyKeys(input, ["limit", "dryRun", "recordId", "kinds", "variant", "force"]);

  let limit: number | undefined;
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isFinite(input.limit)) throw new HttpError(400, "invalid_limit", "limit 必须是数字");
    limit = input.limit;
  }
  let dryRun = false;
  if (input.dryRun !== undefined) {
    if (typeof input.dryRun !== "boolean") throw new HttpError(400, "invalid_dry_run", "dryRun 必须是布尔值");
    dryRun = input.dryRun;
  }
  let recordId: string | undefined;
  if (input.recordId !== undefined) {
    if (typeof input.recordId !== "string" || input.recordId === "") throw new HttpError(400, "invalid_record_id", "recordId 必须是非空字符串");
    recordId = input.recordId;
  }
  let kinds: string[] | undefined;
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds) || input.kinds.length === 0 || !input.kinds.every((kind) => typeof kind === "string" && kind !== "")) {
      throw new HttpError(400, "invalid_kinds", "kinds 必须是非空字符串数组");
    }
    kinds = input.kinds as string[];
  }
  let variant: PhotoDescriptionVariant | undefined;
  if (input.variant !== undefined) {
    if (typeof input.variant !== "string" || !(PHOTO_DESCRIPTION_VARIANTS as readonly string[]).includes(input.variant)) {
      throw new HttpError(400, "invalid_variant", `variant 必须是 ${PHOTO_DESCRIPTION_VARIANTS.join(" / ")}`);
    }
    variant = input.variant as PhotoDescriptionVariant;
  }
  // Re-captioning a pass that is already done. Opt-in on purpose: the default must never
  // be "spend it again".
  let force = false;
  if (input.force !== undefined) {
    if (typeof input.force !== "boolean") throw new HttpError(400, "invalid_force", "force 必须是布尔值");
    force = input.force;
  }

  // Switched off means off — including for this button. The pass refuses the same request
  // on its own, but a silent no-op would look like "it ran and found nothing", which is the
  // one reading that would send her looking for a bug that is not there.
  const targetVariant: PhotoDescriptionVariant = variant ?? "plain";
  if (!isPhotoTextCapabilityEnabled(config, capabilityFor(targetVariant))) {
    const label = CAPABILITY_LABELS[capabilityFor(targetVariant)];
    throw new HttpError(409, "photo_text_disabled", `${label}已在设置中关闭；打开后才会读取照片`);
  }

  const run = await describePhotoLibrary({
    repository,
    config,
    thumbnails,
    ...(limit === undefined ? {} : { limit }),
    dryRun,
    ...(recordId === undefined ? {} : { recordId }),
    ...(kinds === undefined ? {} : { kinds }),
    ...(variant === undefined ? {} : { variant }),
    force,
  });
  setJson(res, 200, {
    ...run,
    // dryRun still calls the model — it only declines to write. Saying so here keeps
    // "preview" from reading as "free".
    note: dryRun ? "dryRun：已调用模型，但未写入任何记录" : "已写入 aiDerived，记录正文未改动",
  });
  return true;
};

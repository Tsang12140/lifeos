import { setJson, HttpError } from "./http-kit.js";
import { readBody, requireJsonContentType } from "./http-body.js";
import { hasOnlyKeys, jsonObject } from "./field-validate.js";
import { PHOTO_DESCRIPTION_VARIANTS, describePhotoLibrary, type PhotoDescriptionVariant } from "./photo-description.js";
import type { RouteHandler } from "./route-context.js";

/**
 * `POST /api/ai/photo-description` — read the photos this library already holds and
 * file one line about each, so a picture the owner never wrote about is still findable.
 *
 * Deliberately manual. Nothing in this codebase arms it on a timer: a scheduled pass
 * would spend her credits while she is still deciding whether the sentences are worth
 * having. Wiring it to a clock is a separate, later decision.
 *
 * `GET` reports what a pass *would* do — how many photos there are, how many already
 * have a line — without reading a single picture or calling the model.
 */
export const handlePhotoDescriptionRoutes: RouteHandler = async (ctx, req, res, pathname) => {
  if (pathname !== "/api/ai/photo-description") return false;
  const { config, repository, thumbnails } = ctx;

  if (req.method === "GET") {
    setJson(res, 200, await describePhotoLibrary({ repository, config, thumbnails, limit: 0, dryRun: true }));
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

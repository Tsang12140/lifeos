import {
  createTencentOcrProbe,
  DEFAULT_TENCENT_OCR_ACTION,
  TENCENT_OCR_ACTIONS,
  type TencentOcrAction,
  type TencentOcrCredentials,
  type PhotoTextRecognizer,
} from "./tencent-ocr.js";

/**
 * The OCR downgrade chain — the preferred engine first, the cheaper one behind it
 * (plan §11).
 *
 * Two facts shape it. The first is that the two actions carry separate 1000-call/month
 * packages, so a preference costs nothing until the preferred one is spent. The second is
 * that **only a service-level refusal means "this tier is out"**: an exhausted package, an
 * account in arrears, a service never opened. Everything else — rate limiting, a timeout,
 * one picture the engine cannot decode — is a reason to skip *that photo* and nothing
 * more.
 *
 * That distinction is the whole design. One network blip must never demote the library,
 * because a demotion is permanent in practice: photos already read are skipped next time,
 * so they would carry the worse engine's transcription for good.
 *
 * The chain lives in process memory and forgets on the 1st of the month, when the free
 * allowance is reissued. Not persisting it costs at most one failed call per restart —
 * and a refusal is not billed (Tencent's own error-code table), so that call is free.
 */

/** What a refusal means for the chain. */
export type OcrRefusal = "downgrade" | "abort" | "skip";

/**
 * Refusals that mean *this tier* cannot serve us, so a lower one might.
 * `ResourcePackageRunOut` is the ordinary end of a month; `InArrears` and `UnOpenError`
 * are configuration faults the next tier can genuinely survive (packages are per action).
 */
const DOWNGRADE_CODES: ReadonlySet<string> = new Set([
  "ResourceUnavailable.ResourcePackageRunOut",
  "ResourceUnavailable.InArrears",
  "FailedOperation.UnOpenError",
]);

/**
 * Refusals that would hit every tier the same way, because they are about the credential
 * or the request rather than the action — re-trying them down the chain would only burn
 * the rest of the pass. They rest for a cooldown instead, so a fixed key recovers without
 * a restart.
 *
 * Tencent spells parameter faults two ways — the common `InvalidParameter` and the
 * business-side `InvalidParameterValue` — so both are listed; an unlisted variant would
 * fall through to "skip", which is the one answer that makes a configuration mistake cost
 * one request per photo.
 */
const ABORT_PREFIXES: readonly string[] = ["AuthFailure", "InvalidParameter", "InvalidParameterValue", "InvalidAction"];

/** How a refusal should be handled. Anything unrecognised is treated as this-photo-only. */
export function classifyOcrFailure(code: string): OcrRefusal {
  if (DOWNGRADE_CODES.has(code)) return "downgrade";
  for (const prefix of ABORT_PREFIXES) {
    if (code === prefix || code.startsWith(`${prefix}.`)) return "abort";
  }
  return "skip";
}

/**
 * Reads the tier list off configuration. Unknown names are dropped rather than throwing —
 * a typo must not stop the photo pass — and an empty or unusable list falls back to the
 * single free-tier-safe action, so a fresh deployment reads pictures without spending.
 */
export function parseOcrActions(raw: string | undefined): readonly TencentOcrAction[] {
  const chosen: TencentOcrAction[] = [];
  for (const piece of (raw ?? "").split(",")) {
    const name = piece.trim();
    if (!(TENCENT_OCR_ACTIONS as readonly string[]).includes(name)) continue;
    const action = name as TencentOcrAction;
    if (!chosen.includes(action)) chosen.push(action);
  }
  return chosen.length > 0 ? chosen : [DEFAULT_TENCENT_OCR_ACTION];
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Midnight on the 1st of next month, Beijing time — when the free allowance is reissued. */
export function nextAllowanceReset(nowMs: number): number {
  const beijing = new Date(nowMs + BEIJING_OFFSET_MS);
  return Date.UTC(beijing.getUTCFullYear(), beijing.getUTCMonth() + 1, 1) - BEIJING_OFFSET_MS;
}

export interface PhotoTextChain {
  /** Hand this to the photo pass. It never throws. */
  readonly recognize: PhotoTextRecognizer;
  /** The action the next call would use; null once every tier is spent. */
  currentAction(): TencentOcrAction | null;
  /** One line per tier change this month, for the run report. */
  readonly events: readonly string[];
}

export interface PhotoTextChainOptions {
  readonly credentials: Omit<TencentOcrCredentials, "action">;
  readonly actions: readonly TencentOcrAction[];
  readonly fetchImpl?: typeof fetch;
  /** Injected clock, so the month reset is testable. */
  readonly now?: () => number;
  /** How long an abort rests before the top tier is tried again. */
  readonly cooldownMs?: number;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function createPhotoTextChain(options: PhotoTextChainOptions): PhotoTextChain {
  const { credentials, actions } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const probes = new Map<TencentOcrAction, ReturnType<typeof createTencentOcrProbe>>();
  const events: string[] = [];
  let tier = 0;
  let restingUntil = 0;
  let resetAt = nextAllowanceReset(now());

  const probeFor = (action: TencentOcrAction) => {
    const existing = probes.get(action);
    if (existing !== undefined) return existing;
    const created = createTencentOcrProbe({ ...credentials, action }, fetchImpl);
    probes.set(action, created);
    return created;
  };

  const recognize: PhotoTextRecognizer = async ({ image }) => {
    const stamp = now();
    if (stamp >= resetAt) {
      tier = 0;
      restingUntil = 0;
      resetAt = nextAllowanceReset(stamp);
      events.length = 0;
      events.push(`新月份：额度重置，回到 ${actions[0]}`);
    }
    if (stamp < restingUntil) return { kind: "unread" };

    while (tier < actions.length) {
      const action = actions[tier] as TencentOcrAction;
      const outcome = await probeFor(action)({ image });
      // Nothing to read is a finished answer — the same photo would say the same thing
      // to every tier, so the chain stays where it is. `blank` carries the tier that
      // confirmed it, which is what an empty marker records as its engine.
      if (outcome.kind === "notext") return { kind: "blank", engine: action };
      if (outcome.kind === "text") return { kind: "text", text: outcome.text, engine: action };

      const refusal = classifyOcrFailure(outcome.code);
      if (refusal === "skip") return { kind: "unread" };
      if (refusal === "abort") {
        restingUntil = stamp + cooldownMs;
        events.push(`${action} 拒绝服务（${outcome.code}），休整 ${Math.round(cooldownMs / 60000)} 分钟后重试`);
        return { kind: "unread" };
      }
      // A downgrade re-runs *this* photo on the next tier: it was not read, and leaving
      // it for a later pass would mean the library never catches up on its own.
      const next = actions[tier + 1];
      tier += 1;
      if (next === undefined) {
        restingUntil = stamp + cooldownMs;
        events.push(`${action} 这一档已用尽（${outcome.code}），后面没有更低的一档`);
        return { kind: "unread" };
      }
      events.push(`${action} → ${next}（${outcome.code}）`);
    }
    // Every tier refused and none of them read the picture: the photo is untouched, so
    // the next run retries it rather than finding a marker that says it was handled.
    return { kind: "unread" };
  };

  return {
    recognize,
    currentAction: () => (tier < actions.length ? (actions[tier] as TencentOcrAction) : null),
    events,
  };
}

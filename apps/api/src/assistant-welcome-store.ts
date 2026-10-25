import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WELCOME_PROMPT_SEEDS, type WelcomeAdminSnapshot, type WelcomePrompt, type WelcomeSelection } from "@lifeos/core";
import { HttpError } from "./http-kit.js";

const DAY = 86_400_000;
const dayKey = (now: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(now));
type Row = { id: string; text: string; enabled: number; general: number; pinned: number; revision: number; text_version: number };
const prompt = (row: Row): WelcomePrompt => ({ id: row.id, text: row.text, enabled: !!row.enabled, general: !!row.general, pinned: !!row.pinned, revision: row.revision, textVersion: row.text_version });
/** Both editorial preference and behavioral feedback are deliberately bounded. */
export function welcomeWeight(general: boolean, views: number, clicks: number) {
  const baseWeight = general ? 1.15 : 1;
  const feedbackBonus = .05 * Math.max(0, Math.min(views, clicks)) / (Math.max(0, views) + 100);
  return { baseWeight, feedbackBonus, effectiveWeight: baseWeight + feedbackBonus };
}
export function drawWelcome<T extends { id: string; pinned: boolean; effectiveWeight: number }>(items: readonly T[], random = () => randomInt(2 ** 32) / 2 ** 32): T[] {
  const chosen: T[] = [], pool = [...items];
  const pinned = pool.findIndex(item => item.pinned);
  if (pinned >= 0) chosen.push(...pool.splice(pinned, 1));
  while (chosen.length < 3 && pool.length) {
    let ticket = Math.max(0, Math.min(1 - Number.EPSILON, random())) * pool.reduce((sum, item) => sum + item.effectiveWeight, 0);
    let index = 0;
    while (index < pool.length - 1 && ticket >= pool[index]!.effectiveWeight) ticket -= pool[index++]!.effectiveWeight;
    chosen.push(...pool.splice(index, 1));
  }
  return chosen;
}
type Ticket = { actor: string; at: number; nonce: string; items: { id: string; version: number }[] };

/** Shared by all accounts, in the owner's database so normal SQLite backups include it. */
export class AssistantWelcomeStore {
  readonly #db: DatabaseSync;
  readonly #secret: string;
  #lastPrune = 0;
  constructor(databasePath: string) {
    this.#db = new DatabaseSync(databasePath, { timeout: 5000 });
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS welcome_meta (id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS welcome_prompts (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, enabled INTEGER NOT NULL, general INTEGER NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, text_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX IF NOT EXISTS welcome_one_pinned ON welcome_prompts(pinned) WHERE pinned=1;
      CREATE TABLE IF NOT EXISTS welcome_events (
        display_id TEXT NOT NULL, prompt_id TEXT NOT NULL, text_version INTEGER NOT NULL, position INTEGER NOT NULL,
        actor TEXT NOT NULL, day TEXT NOT NULL, shown_at INTEGER NOT NULL, clicked_at INTEGER,
        PRIMARY KEY(display_id,prompt_id), UNIQUE(display_id,position)
      );
      CREATE INDEX IF NOT EXISTS welcome_events_stats ON welcome_events(prompt_id,text_version,shown_at);
      CREATE TABLE IF NOT EXISTS welcome_daily (
        actor TEXT NOT NULL, day TEXT NOT NULL, prompt_id TEXT NOT NULL, text_version INTEGER NOT NULL, clicked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(actor,day,prompt_id,text_version)
      );
    `);
    this.#db.prepare("INSERT OR IGNORE INTO welcome_meta VALUES (1,?)").run(randomBytes(32).toString("hex"));
    this.#secret = (this.#db.prepare("SELECT secret FROM welcome_meta WHERE id=1").get() as { secret: string }).secret;
    // A marker, rather than INSERT OR IGNORE on every boot, prevents retired seeds returning later.
    if ((this.#db.prepare("SELECT count(*) AS n FROM welcome_prompts").get() as { n: number }).n === 0) {
      const insert = this.#db.prepare("INSERT INTO welcome_prompts(id,text,enabled,general,pinned) VALUES(?,?,?,?,0)");
      this.#transaction(() => { for (const item of WELCOME_PROMPT_SEEDS) insert.run(item.id, item.text, Number(item.enabled), Number(item.general)); });
    }
  }
  close() { this.#db.close(); }
  #transaction<T>(action: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = action(); this.#db.exec("COMMIT"); return value; }
    catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
  #actor(account: string) { return createHmac("sha256", this.#secret).update(account).digest("hex"); }
  snapshot(days: 7 | 30 | 0 = 30, now = Date.now()): WelcomeAdminSnapshot {
    const since = now - (days || 365) * DAY, feedbackSince = dayKey(now - 29 * DAY);
    const raw = new Map((this.#db.prepare(`SELECT prompt_id,text_version,count(*) AS views,count(clicked_at) AS clicks FROM welcome_events WHERE shown_at>=? GROUP BY prompt_id,text_version`).all(since) as { prompt_id: string; text_version: number; views: number; clicks: number }[]).map(r => [r.prompt_id + ":" + r.text_version, r]));
    const daily = new Map((this.#db.prepare(`SELECT prompt_id,text_version,count(*) AS views,sum(clicked) AS clicks FROM welcome_daily WHERE day>=? GROUP BY prompt_id,text_version`).all(feedbackSince) as { prompt_id: string; text_version: number; views: number; clicks: number }[]).map(r => [r.prompt_id + ":" + r.text_version, r]));
    return { days, items: (this.#db.prepare("SELECT * FROM welcome_prompts ORDER BY id").all() as Row[]).map(row => {
      const p = prompt(row), key = p.id + ":" + p.textVersion, stats = raw.get(key), feedback = daily.get(key);
      const impressions = stats?.views ?? 0, clicks = stats?.clicks ?? 0, feedbackViews = feedback?.views ?? 0, feedbackClicks = feedback?.clicks ?? 0;
      return { ...p, impressions, clicks, clickRate: impressions ? clicks / impressions : 0, feedbackViews, feedbackClicks, ...welcomeWeight(p.general, feedbackViews, feedbackClicks) };
    }) };
  }
  selection(account: string, now = Date.now()): WelcomeSelection {
    const items = drawWelcome(this.snapshot(30, now).items.filter(item => item.enabled));
    if (!items.length) return { selectionId: "", prompts: [] };
    const ticket: Ticket = { actor: this.#actor(account), at: now, nonce: randomUUID(), items: items.map(p => ({ id: p.id, version: p.textVersion })) };
    const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
    const signature = createHmac("sha256", this.#secret).update(payload).digest("base64url");
    return { selectionId: payload + "." + signature, prompts: items.map(({ id, text }) => ({ id, text })) };
  }
  #ticket(selectionId: string, account: string, now: number): { ticket: Ticket; displayId: string } {
    if (selectionId.length > 3000) throw new HttpError(400, "invalid_welcome_selection", "开场问题已失效，请重新打开对话");
    const [payload, signature, extra] = selectionId.split(".");
    const expected = createHmac("sha256", this.#secret).update(payload ?? "").digest("base64url");
    if (!payload || !signature || extra || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new HttpError(400, "invalid_welcome_selection", "开场问题已失效，请重新打开对话");
    const ticket = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Ticket;
    if (ticket.actor !== this.#actor(account)) throw new HttpError(403, "welcome_selection_owner", "开场问题不属于当前账号");
    if (now - ticket.at > DAY || ticket.at - now > 300_000) throw new HttpError(400, "expired_welcome_selection", "开场问题已过期，请重新打开对话");
    return { ticket, displayId: createHash("sha256").update(selectionId).digest("hex") };
  }
  event(account: string, selectionId: string, type: "impression" | "click", promptId?: string, now = Date.now()) {
    const { ticket, displayId } = this.#ticket(selectionId, account, now);
    if (type === "click" && !ticket.items.some(p => p.id === promptId)) throw new HttpError(400, "unknown_welcome_prompt", "问题不在本次展示中");
    return this.#transaction(() => {
      if (now - this.#lastPrune > DAY) {
        // Keep aggregate UI statistics for one year; feedback uses only the last 30 days.
        this.#db.prepare("DELETE FROM welcome_events WHERE shown_at<?").run(now - 366 * DAY);
        this.#db.prepare("DELETE FROM welcome_daily WHERE day<?").run(dayKey(now - 31 * DAY));
        this.#lastPrune = now;
      }
      const live = ticket.items.map(p => this.#db.prepare("SELECT * FROM welcome_prompts WHERE id=? AND text_version=? AND enabled=1").get(p.id, p.version) as Row | undefined);
      if (live.some(p => !p)) return { counted: false };
      if (type === "impression") {
        let changed = false;
        for (const [position, p] of live.entries()) {
          const result = this.#db.prepare("INSERT OR IGNORE INTO welcome_events(display_id,prompt_id,text_version,position,actor,day,shown_at) VALUES(?,?,?,?,?,?,?)").run(displayId, p!.id, p!.text_version, position, ticket.actor, dayKey(now), now);
          changed ||= !!result.changes;
          this.#db.prepare("INSERT OR IGNORE INTO welcome_daily(actor,day,prompt_id,text_version) VALUES(?,?,?,?)").run(ticket.actor, dayKey(now), p!.id, p!.text_version);
        }
        return { counted: changed };
      }
      const shown = this.#db.prepare("SELECT day FROM welcome_events WHERE display_id=? AND prompt_id=? AND actor=?").get(displayId, promptId!, ticket.actor) as { day: string } | undefined;
      if (!shown) return { counted: false }; // Clicking an unshown ticket cannot manufacture impressions.
      const result = this.#db.prepare("UPDATE welcome_events SET clicked_at=? WHERE display_id=? AND prompt_id=? AND clicked_at IS NULL AND NOT EXISTS(SELECT 1 FROM welcome_events WHERE display_id=? AND clicked_at IS NOT NULL)").run(now, displayId, promptId!, displayId);
      if (result.changes) {
        const item = ticket.items.find(p => p.id === promptId)!;
        this.#db.prepare("UPDATE welcome_daily SET clicked=1 WHERE actor=? AND day=? AND prompt_id=? AND text_version=?").run(ticket.actor, shown.day, item.id, item.version);
      }
      return { counted: !!result.changes };
    });
  }
  create(text: string, general: boolean): WelcomePrompt {
    if ((this.#db.prepare("SELECT count(*) AS n FROM welcome_prompts").get() as { n: number }).n >= 100) throw new HttpError(400, "welcome_pool_full", "最多保留100条开场问题");
    const id = "custom-" + randomUUID();
    this.#db.prepare("INSERT INTO welcome_prompts(id,text,enabled,general) VALUES(?,?,1,?)").run(id, text, Number(general));
    return prompt(this.#db.prepare("SELECT * FROM welcome_prompts WHERE id=?").get(id) as Row);
  }
  update(id: string, revision: number, patch: Partial<Pick<WelcomePrompt, "text" | "enabled" | "general" | "pinned">>): WelcomePrompt {
    return this.#transaction(() => {
      const current = this.#db.prepare("SELECT * FROM welcome_prompts WHERE id=?").get(id) as Row | undefined;
      if (!current) throw new HttpError(404, "unknown_welcome_prompt", "找不到这条开场问题");
      if (current.revision !== revision) throw new HttpError(409, "welcome_revision_conflict", "问题已被修改，请刷新后再试");
      const next = { ...prompt(current), ...patch };
      if (!next.enabled) next.pinned = false;
      if (next.pinned) this.#db.prepare("UPDATE welcome_prompts SET pinned=0,revision=revision+1 WHERE pinned=1 AND id<>?").run(id);
      this.#db.prepare("UPDATE welcome_prompts SET text=?,enabled=?,general=?,pinned=?,revision=revision+1,text_version=text_version+? WHERE id=?").run(next.text, Number(next.enabled), Number(next.general), Number(next.pinned), Number(next.text !== current.text), id);
      return prompt(this.#db.prepare("SELECT * FROM welcome_prompts WHERE id=?").get(id) as Row);
    });
  }
}

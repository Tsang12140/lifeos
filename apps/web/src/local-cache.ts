/**
 * What this browser keeps for LifeOS, and what may be thrown away.
 *
 * The app writes a fair amount into `localStorage` — interface font, task sort and
 * density, the calendar view, date art, the AI launcher's position, the private
 * switches' 24h grants. All of it is *reproducible*: the defaults come back and the
 * next click writes them again. That is the set this module counts and empties.
 *
 * Five things are deliberately out of reach:
 *
 * - **Unfinished writing.** Composer drafts, note drafts, the AI backfill input and
 *   import receipts are the owner's own words or a record that a file was already
 *   taken in. Emptying a cache must never cost a sentence, so they are named in
 *   `KEEP_PREFIXES` and skipped even though they live in the same drawer.
 * - **"I already dismissed that" flags.** A tour that was read or a prompt that was
 *   closed would pop back up if its flag vanished. That is not a default, it is a
 *   regression — so those flags are kept too.
 * - **Decisions about what the screen shows.** These are the dangerous ones, because
 *   the loss does not look like a lost preference — it looks like lost data. Turning
 *   private records on and then wiping the cache makes every private record vanish
 *   from the timeline, and the owner's first thought is "my records are gone". Same
 *   for the hidden demo records reappearing, an assistant that was switched off
 *   coming back, or photo timestamps the owner deliberately hid showing up again.
 *   A "back to defaults" that silently reverses a deliberate choice is not a default.
 * - **`sessionStorage`.** Everything there dies with the tab. Clearing it would buy
 *   nothing and could take a draft along, so this module never touches it.
 * - **The offline mobile week-summary font.** Its complete bytes live in a dedicated,
 *   profile-scoped IndexedDB font library. This action only enumerates `localStorage`
 *   keys, so it cannot remove that library; browser-level site-data clearing can.
 *
 * The video originals (`lifeos-video-originals-v1`) are in IndexedDB, not here, so
 * they are untouched by construction — the card says so rather than guarding it.
 */
import { PROFILE_SCOPE } from "./storage-scope";

/** Every key the app writes starts here; anything else in the drawer is not ours. */
const APP_PREFIX = "lifeos";

/**
 * Values that cannot be rebuilt. Prefixes are matched against the key *without* the
 * profile suffix, so a card and the real library are treated alike.
 *
 * Three kinds live here. The owner's unfinished writing — emptying a cache must never
 * cost a sentence. The "I already dismissed that" bookkeeping: an introduction or a
 * prompt that was closed once and would pop back up if the flag vanished. Coming
 * back from a cache wipe to a tour you finished months ago is not a default, it is a
 * regression. And the decisions about what the screen is allowed to show: those are
 * the ones that read as data loss (private records disappearing off the timeline),
 * not as a preference resetting.
 *
 * A new browser key that carries any of the three must be registered here, otherwise
 * "清理本地缓存" will quietly delete it.
 */
const KEEP_PREFIXES: readonly string[] = [
  "lifeos.composerDraft.v1.", // 输入区草稿：正文、配图、标注决定
  "lifeos.composerShots", // 旧版输入区配图（同一件事的旧键）
  "lifeos:note-draft:", // 笔记里写了一半的字
  "lifeos.backfill.input:", // AI 补记输入框
  "lifeos.backfill.edit:", // AI 补记的逐条修改
  "lifeos:note-import:", // 导入回执；删掉会重复导入同一份文件
  "lifeos.ai.backfill-introduced", // AI 补记引导「已经介绍过」
  "lifeos.moviePromptHidden", // 观影提示「已经关掉过」
  "lifeos.privacy.visible.v1", // 私密记录的常驻开关：清掉它们会整片从时间线上消失，看着像记录被删了
  "lifeos.privacy.access.v2:", // 私密模块「一直允许」：清掉等于替主人撤销一次明确授权
  "lifeos.hideDemo", // 「隐藏预置记录」：清掉后预置记录又冒出来
  "lifeos.ai.assistant-visible", // AI 助手开关：清掉后关掉的助手自己回来
  "lifeos.photoTimeDefault", // 照片拍摄时间默认显示：清掉后刻意藏起来的时间又露出来
];

export interface LocalCacheFootprint {
  readonly entries: number;
  readonly bytes: number;
}

/** The real library carries no suffix; a card's keys end with `@<card>`. */
function scopeSuffix(): string {
  return PROFILE_SCOPE === "" ? "" : `@${PROFILE_SCOPE}`;
}

/**
 * Whose drawer entry is this. A card must not empty the real library's keys (they
 * share one origin), and the real library must not empty a card's — so the suffix
 * decides, not the prefix alone.
 */
function isOurs(key: string): boolean {
  if (!key.startsWith(APP_PREFIX)) return false;
  const suffix = scopeSuffix();
  // Real library: any `@` suffix belongs to a card, so it is not ours to clear.
  if (suffix === "") return key.indexOf("@") === -1;
  return key.endsWith(suffix);
}

function baseName(key: string): string {
  const suffix = scopeSuffix();
  return suffix !== "" && key.endsWith(suffix) ? key.slice(0, -suffix.length) : key;
}

function keeps(key: string): boolean {
  const base = baseName(key);
  return KEEP_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** Collect first, delete after: removing while indexing shifts the keys underneath. */
function targetKeys(): readonly string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null && isOurs(key) && !keeps(key)) keys.push(key);
    }
  } catch {
    // Private mode or a blocked storage partition: report nothing rather than throw.
    return [];
  }
  return keys;
}

/** Bytes as the browser charges them: UTF-16 code units, two bytes each. */
function weigh(key: string, value: string): number {
  return (key.length + value.length) * 2;
}

export function readLocalCacheFootprint(): LocalCacheFootprint {
  let entries = 0;
  let bytes = 0;
  for (const key of targetKeys()) {
    entries += 1;
    bytes += weigh(key, window.localStorage.getItem(key) ?? "");
  }
  return { entries, bytes };
}

export function clearLocalCache(): LocalCacheFootprint {
  let entries = 0;
  let bytes = 0;
  for (const key of targetKeys()) {
    const value = window.localStorage.getItem(key) ?? "";
    try {
      window.localStorage.removeItem(key);
      entries += 1;
      bytes += weigh(key, value);
    } catch {
      // A refused removal leaves the entry in place; the next count will still show it.
    }
  }
  return { entries, bytes };
}

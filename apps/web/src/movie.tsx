import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Film, LoaderCircle, PlugZap, Search, Star, X } from "lucide-react";
import { findEntityCandidates, type Entity, type TextEntityDecision } from "@lifeos/core";
import {
  apiRequest,
  type MovieEntity,
  type MovieEntityRef,
  type MovieModulePayload,
  type MovieModuleStatus,
  type MovieResolveCandidate,
  type MovieResolveResponse,
} from "./api";

/** The command registry is deliberately data-only so another optional module
 * can register a slash command without adding another composer branch. */
export interface ModuleCommand {
  readonly id: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly description: string;
}

/** The value shown by MovieSettingsCard is only writable when status came
 * from a successful server read. Keep the last confirmed status across an
 * ordinary read failure so the card can explain what was last known. */
export type MovieModuleStatusState =
  | { readonly phase: "loading"; readonly status: MovieModuleStatus | null }
  | { readonly phase: "ready"; readonly status: MovieModuleStatus }
  | { readonly phase: "failed"; readonly status: MovieModuleStatus | null; readonly error: string };

export const MOVIE_COMMAND: ModuleCommand = {
  id: "movie",
  label: "电影",
  aliases: ["观影"],
  description: "识别并添加一部电影",
};

export function enabledModuleCommands(movieEnabled: boolean): readonly ModuleCommand[] {
  return movieEnabled ? [MOVIE_COMMAND] : [];
}

const MOVIE_ENDPOINTS = {
  status: ["/api/movie/status"] as const,
  saveConfig: ["/api/movie/config"] as const,
  testConfig: ["/api/movie/config/test"] as const,
  resolve: ["/api/movie/resolve"] as const,
  import: ["/api/movie/import"] as const,
  upsert: ["/api/movie/upsert"] as const,
};

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status
    : undefined;
}

async function requestMovie<T>(paths: readonly string[], init: RequestInit = {}): Promise<T> {
  let lastError: unknown;
  for (const path of paths) {
    try {
      return await apiRequest<T>(path, init);
    } catch (error) {
      lastError = error;
      // Keep the compatibility shim narrow: a real provider/API failure must
      // be surfaced instead of issuing the same mutation twice.
      if (statusOf(error) !== 404 && statusOf(error) !== 405) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("电影模块接口不可用");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function externalIdsOf(value: unknown): MovieEntity["externalIds"] {
  if (!isRecord(value)) return undefined;
  const providerId = (candidate: unknown): string | undefined => {
    if (typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0) return String(candidate);
    return stringValue(candidate);
  };
  const result = {
    ...(providerId(value.tmdb) === undefined ? {} : { tmdb: providerId(value.tmdb) }),
    ...(providerId(value.imdb) === undefined ? {} : { imdb: providerId(value.imdb) }),
    ...(providerId(value.douban) === undefined ? {} : { douban: providerId(value.douban) }),
  };
  return Object.keys(result).length === 0 ? undefined : result;
}

/** Turn provider-shaped candidates and imported entities into one safe UI
 * shape. No provider data is trusted enough to be used as an HTML fragment. */
export function normalizeMovie(value: unknown): MovieEntity | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.entity) ? value.entity : isRecord(value.movie) ? value.movie : value;
  const name = stringValue(nested.name) ?? stringValue(nested.title) ?? stringValue(nested.originalTitle);
  const id = stringValue(nested.id) ?? stringValue(nested.entityId) ?? stringValue(nested.tmdbId) ?? stringValue(nested.imdbId);
  if (name === undefined || id === undefined) return null;
  const aliases = Array.isArray(nested.aliases) ? nested.aliases.filter((item): item is string => typeof item === "string" && item.trim() !== "") : undefined;
  const releaseYear = numberValue(nested.releaseYear) ?? numberValue(nested.year);
  const externalIds = externalIdsOf(nested.externalIds ?? nested.external_ids);
  const posterUrl = stringValue(nested.posterUrl) ?? stringValue(nested.poster_path) ?? stringValue(nested.poster);
  const overview = stringValue(nested.overview) ?? stringValue(nested.description);
  const personalReview = typeof nested.personalReview === "string" ? nested.personalReview : typeof nested.review === "string" ? nested.review : undefined;
  const watchedAt = stringValue(nested.watchedAt);
  // Only the two values TMDb actually emits are accepted; anything else is
  // dropped rather than guessed at, so a malformed payload cannot relabel a film.
  const mediaType = nested.mediaType === "tv" ? "tv" : nested.mediaType === "movie" ? "movie" : undefined;
  return {
    id,
    type: "movie",
    name,
    ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
    ...(mediaType === undefined ? {} : { mediaType }),
    ...(stringValue(nested.originalTitle) === undefined ? {} : { originalTitle: stringValue(nested.originalTitle) }),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(posterUrl === undefined ? {} : { posterUrl }),
    ...(overview === undefined ? {} : { overview }),
    ...(externalIds === undefined ? {} : { externalIds }),
    ...(numberValue(nested.doubanRating) === undefined ? {} : { doubanRating: numberValue(nested.doubanRating) }),
    ...(numberValue(nested.personalRating) === undefined ? {} : { personalRating: numberValue(nested.personalRating) }),
    ...(personalReview === undefined ? {} : { personalReview }),
    ...(watchedAt === undefined ? {} : { watchedAt }),
    ...(typeof nested.watched === "boolean" ? { watched: nested.watched } : {}),
  };
}

function candidatesFromPayload(payload: unknown): readonly MovieResolveCandidate[] {
  const source: unknown = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? payload.items ?? payload.candidates ?? payload.results ?? payload.data
      : undefined;
  if (!Array.isArray(source)) {
    const single = normalizeMovie(payload);
    return single === null ? [] : [single];
  }
  return source.map((item) => normalizeMovie(item)).filter((item): item is MovieEntity => item !== null);
}

function normalizeStatus(payload: unknown): MovieModuleStatus {
  const root = isRecord(payload) ? payload : {};
  const nestedStatus = isRecord(root.status) ? root.status : {};
  const nestedConfig = isRecord(root.config) ? root.config : {};
  const enabled = typeof nestedStatus.enabled === "boolean" ? nestedStatus.enabled : typeof nestedConfig.enabled === "boolean" ? nestedConfig.enabled : typeof root.enabled === "boolean" ? root.enabled : false;
  const keyConfigured = typeof nestedStatus.keyConfigured === "boolean" ? nestedStatus.keyConfigured : typeof nestedStatus.hasKey === "boolean" ? nestedStatus.hasKey : typeof nestedConfig.keyConfigured === "boolean" ? nestedConfig.keyConfigured : typeof nestedConfig.hasKey === "boolean" ? nestedConfig.hasKey : typeof root.keyConfigured === "boolean" ? root.keyConfigured : typeof root.hasKey === "boolean" ? root.hasKey : false;
  const configured = typeof nestedStatus.configured === "boolean" ? nestedStatus.configured : typeof nestedConfig.configured === "boolean" ? nestedConfig.configured : typeof root.configured === "boolean" ? root.configured : keyConfigured;
  const connected = typeof nestedStatus.connected === "boolean" ? nestedStatus.connected : typeof nestedStatus.available === "boolean" ? nestedStatus.available : typeof root.connected === "boolean" ? root.connected : configured;
  const provider = stringValue(nestedStatus.provider) ?? stringValue(root.provider) ?? stringValue(root.source);
  const message = stringValue(nestedStatus.message) ?? stringValue(root.message);
  // 本地片库的状态白名单式拷一遍：不回显 path 之外的东西，也不让脏字段漏进 UI。
  const rawCatalog = isRecord(nestedStatus.catalog) ? nestedStatus.catalog : isRecord(root.catalog) ? root.catalog : undefined;
  const catalog = rawCatalog === undefined ? undefined : {
    available: rawCatalog.available === true,
    path: typeof rawCatalog.path === "string" ? rawCatalog.path : "",
    titles: typeof rawCatalog.titles === "number" ? rawCatalog.titles : 0,
    terms: typeof rawCatalog.terms === "number" ? rawCatalog.terms : 0,
    sizeMb: typeof rawCatalog.sizeMb === "number" ? rawCatalog.sizeMb : 0,
  };
  return { enabled, configured, keyConfigured, connected, ...(provider === undefined ? {} : { provider }), ...(message === undefined ? {} : { message }), ...(catalog === undefined ? {} : { catalog }) };
}

export async function fetchMovieModuleStatus(signal?: AbortSignal): Promise<MovieModuleStatus> {
  return normalizeStatus(await requestMovie<MovieModulePayload>(MOVIE_ENDPOINTS.status, { signal }));
}

export async function saveMovieModuleConfig(enabled: boolean, apiKey: string): Promise<MovieModuleStatus> {
  const body = JSON.stringify({ enabled, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
  return normalizeStatus(await requestMovie<MovieModulePayload>(MOVIE_ENDPOINTS.saveConfig, { method: "POST", body }));
}

export async function testMovieModule(apiKey: string): Promise<string> {
  const payload = await requestMovie<MovieModulePayload>(MOVIE_ENDPOINTS.testConfig, { method: "POST", body: JSON.stringify(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
  return normalizeStatus(payload).message ?? "TMDb 连接成功";
}

export async function resolveMovie(query: string): Promise<readonly MovieResolveCandidate[]> {
  return candidatesFromPayload(await requestMovie<MovieResolveResponse | readonly MovieResolveCandidate[]>(MOVIE_ENDPOINTS.resolve, { method: "POST", body: JSON.stringify({ query: query.trim() }) }));
}

export async function importMovie(candidate: MovieResolveCandidate): Promise<MovieEntity> {
  const payload = await requestMovie<unknown>(MOVIE_ENDPOINTS.import, { method: "POST", body: JSON.stringify({ candidate }) });
  return normalizeMovie(payload) ?? normalizeMovie(candidate) ?? { ...candidate, type: "movie" };
}

export async function upsertMovie(movie: MovieEntity): Promise<MovieEntity> {
  // Library entities also carry storage metadata such as createdAt. The movie
  // endpoint accepts only movie fields, already defined by this normalizer.
  const payload = await requestMovie<unknown>(MOVIE_ENDPOINTS.upsert, { method: "POST", body: JSON.stringify(normalizeMovie(movie) ?? movie) });
  return normalizeMovie(payload) ?? movie;
}

export function movieRef(movie: MovieEntity): MovieEntityRef {
  return { entityType: "movie", entityId: movie.id, label: movie.name };
}

/**
 * Naming the film *is* the mark. Picking a title in the panel means the words
 * that made you search for it — or the ones the prose already spells out — now
 * point at that film, so they get a decision on the spot instead of waiting in
 * 「检查标记」 for a second confirmation. Same rule the composer already applies
 * to a person or place created from a selection (`markCreatedEntity`).
 *
 * Returns `null` when there is nothing to mark, so callers can tell "already
 * done" from "wrote a decision".
 */
export function movieMentionDecisions(
  content: string,
  entities: readonly Entity[],
  decisions: readonly TextEntityDecision[],
  entity: Entity,
  selection?: { readonly start: number; readonly end: number; readonly text: string } | null,
): readonly TextEntityDecision[] | null {
  if (entity.type !== "movie") return null;
  const vocabulary = entities.some((item) => item.id === entity.id) ? entities : [...entities, entity];
  const ranges: { start: number; end: number; text: string }[] = findEntityCandidates(content, vocabulary)
    .filter((candidate) => candidate.entities.some((item) => item.id === entity.id))
    .map((candidate) => ({ start: candidate.start, end: candidate.end, text: candidate.text }));
  // The selection may be the author's own wording rather than the catalogue
  // title (搜「盗梦空间」拿到 Inception) — that occurrence is exactly the one he
  // pointed at, so it is marked as it stands.
  if (selection !== undefined && selection !== null && selection.text.length > 0
    && content.slice(selection.start, selection.end) === selection.text
    && !ranges.some((range) => range.start < selection.end && selection.start < range.end)) {
    ranges.push({ start: selection.start, end: selection.end, text: selection.text });
  }
  const fresh = ranges.filter((range) => !decisions.some((decision) => decision.start === range.start && decision.end === range.end));
  if (fresh.length === 0) return null;
  return [...decisions, ...fresh.map((range) => ({ ...range, entityId: entity.id, entityType: "movie" as const }))]
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function movieMeta(movie: Pick<MovieEntity, "originalTitle" | "releaseYear">): string {
  return [movie.originalTitle, movie.releaseYear === undefined ? undefined : String(movie.releaseYear)].filter(Boolean).join("，");
}

/**
 * What kind of thing this is, in the owner's words. Search now runs through
 * TMDb's `/search/multi`, so a candidate list can hold films and series side by
 * side — and a series is exactly what a bare film search used to hide.
 * Undefined means "film": every entity saved before `mediaType` existed.
 */
function mediaTypeLabel(mediaType: MovieEntity["mediaType"]): string | undefined {
  return mediaType === "tv" ? "剧集" : mediaType === "movie" ? "电影" : undefined;
}

function moviePoster(movie: Pick<MovieEntity, "posterUrl">): string | undefined {
  const value = movie.posterUrl?.trim();
  return value ? value : undefined;
}

export function MovieSettingsCard({ statusState, onChanged, onRetry }: { readonly statusState: MovieModuleStatusState; readonly onChanged: (status: MovieModuleStatus) => void; readonly onRetry: () => void }) {
  const status = statusState.status;
  const statusReady = statusState.phase === "ready" && status !== null;
  const [enabled, setEnabled] = useState(status?.enabled ?? false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testPassed, setTestPassed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (status !== null) setEnabled(status.enabled); }, [statusState.phase, status?.enabled]);
  useEffect(() => { if (statusState.phase !== "ready") setTestPassed(false); }, [statusState.phase]);
  const save = async () => {
    if (!statusReady || status === null || busy || testing) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const next = await saveMovieModuleConfig(enabled, apiKey);
      setApiKey(""); onChanged(next); setMessage(enabled ? "观影模块已保存" : "观影模块已关闭，已保存影片仍会保留");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "观影模块保存失败，请重试"); }
    finally { setBusy(false); }
  };
  const test = async () => {
    if (!statusReady || status === null || busy || testing) return;
    setTesting(true); setTestPassed(false); setMessage(null); setError(null);
    try { const result = await testMovieModule(apiKey); setTestPassed(true); setMessage(result); }
    catch (cause) { setTestPassed(false); setError(cause instanceof Error ? cause.message : "TMDb 连接失败，请检查 Key"); }
    finally { setTesting(false); }
  };
  const confirmedLabel = status === null ? null : !status.enabled ? "已关闭" : status.connected ? "已连接" : status.keyConfigured ? "待测试" : "未配置";
  const stateLabel = statusState.phase === "ready" ? testPassed ? "测试通过" : confirmedLabel : statusState.phase === "loading" ? status === null ? "正在读取状态…" : "正在刷新状态…" : status === null ? "状态暂时不可读取" : "状态读取失败";
  return <div className="settings-card movie-settings-card" data-movie-settings>
    <div className="movie-settings-head"><div className="settings-card-icon movie-icon"><Film size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>观影模块</strong><small>可选。先用本地 IMDb 片库离线识别，查不到才问 TMDb；豆瓣链接只存成外部 ID</small></div><span className={`settings-status ${statusState.phase === "ready" && (testPassed || (status?.enabled && status.connected)) ? "is-ready" : ""}`} data-movie-status-phase={statusState.phase} data-movie-test-result={testPassed ? "passed" : undefined}>{stateLabel}</span></div>
    {statusState.phase === "failed" ? <div className="movie-settings-read-error" role="alert"><span>{statusState.error}</span>{status === null ? null : <small>上次确认：{confirmedLabel}（模块{status.enabled ? "已启用" : "已关闭"}）</small>}<button className="secondary-button" type="button" onClick={onRetry}>重试读取</button></div> : null}
    <div className="movie-settings-fields">
      {/* 这一行**只能**吃 `.movie-enabled-toggle`（原生 checkbox + 文字的一整行）。
          绝不能同时挂 `.settings-switch` —— 那是另一套设计（44×26 的假药丸，把 `input`
          绝对定位成 1px + `opacity:0`，靠 `span` 画滑块）。两套一起挂的实测后果：
          整行被钉成 44×26、假药丸被 `display:none` 干掉、原生 checkbox 被 `opacity:0` 干掉
          ⇒ 一个可勾的东西都没有；「启用观影模块」七个字挤进 22px 宽、竖着堆成 8 行（高 96px）、
          上下各溢出 28px。守它的是 `.review/verify-movie-toggle-ui.mjs`。 */}
      {status === null ? <p className="movie-settings-unavailable">状态确认后，才能调整观影模块或提交配置。</p> : <label className="movie-enabled-toggle"><input type="checkbox" checked={enabled} disabled={!statusReady} onChange={(event) => setEnabled(event.target.checked)} aria-label="启用观影模块" /><span aria-hidden="true" /><strong>启用观影模块</strong></label>}
      <label><span>TMDb Key（可选）{status?.keyConfigured ? "（留空保留已保存的密钥）" : ""}</span><input type="password" value={apiKey} disabled={!statusReady} onChange={(event) => { setApiKey(event.target.value); setTestPassed(false); }} autoComplete="new-password" /></label>
    </div>
    <div className="movie-settings-actions"><button className="icon-text-button" type="button" onClick={() => void test()} disabled={!statusReady || busy || testing}>{testing ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}<span>{testing ? "测试中…" : "测试连接"}</span></button><button className="primary-button" type="button" onClick={() => void save()} disabled={!statusReady || busy || testing}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存配置"}</span></button></div>
    {message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
    {status?.catalog !== undefined && status.catalog.available ? <p className="movie-settings-note" data-movie-catalog="ready">本地片库 {status.catalog.titles.toLocaleString()} 部 · {status.catalog.sizeMb} MB，不联网也能搜片。</p> : status?.catalog !== undefined ? <p className="movie-settings-note" data-movie-catalog="missing">还没有本地片库：在项目根目录跑 node scripts/imdb-catalog.mjs --download，再跑 --build。没有它就只能靠 TMDb。</p> : null}
    <p className="movie-settings-note">Key 只提交到 API 服务端，不进入 localStorage，也不会回显。</p>
  </div>;
}

interface MovieAddPanelProps {
  readonly enabled: boolean;
  readonly onAttach: (movie: MovieEntity) => void;
  readonly onClose?: () => void;
  readonly compact?: boolean;
  /**
   * A title handed in from outside — the right-click 「识别为影片」 action passes
   * the cleaned selection here. It is searched on arrival: the owner has already
   * pointed at the text he means, so asking him to press 识别 as well would be
   * asking the same question twice.
   */
  readonly initialQuery?: string;
  /**
   * Only the in-timeline prompt passes this. The composer's panel has no
   * "不再提示" to offer — there is nothing there to suppress.
   */
  readonly onSuppress?: () => void;
}

export function MovieAddPanel({ enabled, onAttach, onClose, compact = false, initialQuery, onSuppress }: MovieAddPanelProps) {
  const [query, setQuery] = useState(initialQuery?.trim() ?? "");
  const [candidates, setCandidates] = useState<readonly MovieResolveCandidate[]>([]);
  const [selected, setSelected] = useState<MovieResolveCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 只有浮层形态（桌面输入区）需要「点外面收起」：手机端它是底部弹层，关不关由
  // 外层那个 sheet 决定，传进来的 onClose 是 undefined。跳两级到锚点容器，
  // 是为了让点影片按钮本身不算 outside —— 否则按下就关、抬起又开，按钮看着像失灵。
  useEffect(() => {
    if (onClose === undefined) return undefined;
    const outside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!(event.target instanceof Node)) return;
      if (root?.contains(event.target) === true || root?.parentElement?.parentElement?.contains(event.target) === true) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [onClose]);
  // `runResolve` takes its term as an argument so the same path serves both the
  // form and the auto-search below — one code path, so a bug cannot live in only
  // one of the two ways into the panel.
  const runResolve = async (raw: string) => {
    const term = raw.trim();
    if (!enabled || busy || !term) return;
    setBusy(true); setError(null); setMessage(null); setSelected(null);
    try {
      const next = await resolveMovie(term);
      setCandidates(next);
      if (next.length === 0) setMessage("没有找到匹配影片，请换一个片名或链接");
    } catch (cause) { setCandidates([]); setError(cause instanceof Error ? cause.message : "识别失败，请检查观影模块配置"); }
    finally { setBusy(false); }
  };
  const resolve = async (event: FormEvent) => {
    event.preventDefault();
    await runResolve(query);
  };
  const incomingQuery = initialQuery?.trim() ?? "";
  const autoSearched = useRef<string | null>(null);
  useEffect(() => {
    // Guarded by the last term searched, not by a mount flag: the panel stays
    // mounted while it is open, and a second right-click with different text
    // must search again rather than silently keep the first result set.
    if (incomingQuery === "" || !enabled || autoSearched.current === incomingQuery) return;
    autoSearched.current = incomingQuery;
    setQuery(incomingQuery);
    void runResolve(incomingQuery);
  }, [incomingQuery, enabled]);
  const attach = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { const movie = await importMovie(selected); onAttach(movie); setCandidates([]); setSelected(null); setQuery(""); setMessage("影片已加入这条记录"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "影片保存失败，请重试"); }
    finally { setBusy(false); }
  };
  return <div className={`movie-add-panel ${compact ? "is-compact" : ""}`} data-movie-add-panel ref={rootRef}>
    {!enabled ? <p className="movie-panel-muted">请先在设置中启用观影模块。</p> : <>
      {/* 一条胶囊顶掉原来的标题+副标题：豆瓣／IMDb／TMDb 的用法改成占位提示，
          不再常驻两行说明（DESIGN §1、§2）。关闭键留在胶囊右端，位置与地点的定位键一致。 */}
      <form className="movie-resolve-form" role="search" onSubmit={resolve}>
        <Search size={16} strokeWidth={1.8} aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="电影识别内容" autoFocus={!compact} placeholder="片名、豆瓣或 IMDb 链接" />
        <button className="movie-resolve-submit" type="submit" disabled={!query.trim() || busy}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}<span>{busy ? "识别中…" : "识别"}</span></button>
        {onClose ? <button className="movie-search-close" type="button" onClick={onClose} aria-label="关闭添加电影"><X size={15} aria-hidden="true" /></button> : null}
      </form>
      {candidates.length > 0 ? <div className="movie-candidates" role="listbox" aria-label="电影候选">{candidates.map((candidate) => { const kind = mediaTypeLabel(candidate.mediaType); // 原名与片名相同（中文片很常见）时不再重复印一遍。
        const originalTitle = candidate.originalTitle?.trim() ?? ""; const original = originalTitle !== "" && originalTitle.toLocaleLowerCase() !== candidate.name.trim().toLocaleLowerCase() ? originalTitle : null; const year = candidate.releaseYear === undefined ? null : String(candidate.releaseYear); return <button className={`movie-candidate ${selected?.id === candidate.id ? "is-selected" : ""}`} data-movie-candidate={candidate.id} type="button" role="option" aria-selected={selected?.id === candidate.id} key={candidate.id} onClick={() => setSelected(candidate)}>{moviePoster(candidate) ? <img src={moviePoster(candidate)} alt="" loading="lazy" /> : <span className="movie-candidate-fallback" aria-hidden="true"><Film size={15} /></span>}<span><span className="movie-candidate-title"><strong>{candidate.name}</strong>{kind ? <i className="movie-candidate-kind" data-movie-kind={candidate.mediaType}>{kind}</i> : null}</span>{original ? <small>{original}</small> : null}{candidate.overview ? <em>{candidate.overview}</em> : null}</span>{year ? <small className="movie-candidate-year">{year}</small> : null}</button>; })}</div> : null}
      {message ? <p className="movie-panel-message" role="status">{message}</p> : null}{error ? <p className="movie-panel-error" role="alert">{error}</p> : null}
      {/* 底栏：左「以后不再提示」（借用地点面板底栏的文本按钮外形），右主操作。
          两者都没有时不画那条分隔线。 */}
      {selected || onSuppress ? <div className="movie-panel-footer">{onSuppress ? <button className="movie-panel-suppress" type="button" onClick={onSuppress}>以后不再提示</button> : null}{selected ? <div className="movie-add-selected"><span>已选择：{selected.name}</span><button className="primary-button" type="button" onClick={() => void attach()} disabled={busy}>{busy ? "保存中…" : "添加到记录"}</button></div> : null}</div> : null}
    </>}
  </div>;
}

export function MovieCardDialog({ entity, onClose, onSaved }: { readonly entity: MovieEntity | null; readonly onClose: () => void; readonly onSaved: (movie: MovieEntity) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [rating, setRating] = useState("");
  const [review, setReview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (entity) { setRating(entity.personalRating === undefined ? "" : String(entity.personalRating)); setReview(entity.personalReview ?? ""); setError(null); }
  }, [entity?.id]);
  useEffect(() => { const dialog = dialogRef.current; if (!dialog) return; if (entity && !dialog.open) dialog.showModal(); if (!entity && dialog.open) dialog.close(); }, [entity]);
  if (entity === null) return <dialog ref={dialogRef} className="modal-dialog" />;
  const poster = moviePoster(entity);
  const close = () => { if (!busy) onClose(); };
  const save = async () => {
    if (busy) return;
    const parsed = rating.trim() === "" ? undefined : Number(rating);
    if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0 || parsed > 10 || Math.abs(parsed * 2 - Math.round(parsed * 2)) > 1e-8)) { setError("评分请输入 0 到 10 之间、以 0.5 为步长的数字"); return; }
    setBusy(true); setError(null);
    try {
      const updated = await upsertMovie({ ...entity, personalRating: parsed, personalReview: review.trim() || undefined });
      onSaved(updated); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存评分失败，请重试"); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialogRef} className="modal-dialog movie-card-dialog" data-movie-card={entity.id} aria-labelledby="movie-card-title" onCancel={(event) => { event.preventDefault(); close(); }} onClose={close}>
    <div className="movie-card-hero">{poster ? <img className="movie-card-poster" src={poster} alt={`${entity.name} 海报`} onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <div className="movie-card-poster movie-card-poster-fallback" aria-hidden="true"><Film size={29} /></div>}<div className="movie-card-heading"><p className="eyebrow">{entity.mediaType === "tv" ? "剧集卡片" : "电影卡片"}</p><h2 id="movie-card-title">《{entity.name}》</h2>{movieMeta(entity) ? <p>{movieMeta(entity)}</p> : null}{entity.watched && !entity.watchedAt ? <small>已看，观看日期未记录</small> : null}{entity.watchedAt ? <small>观看于 {entity.watchedAt.slice(0, 10)}</small> : null}</div><button className="icon-button compact-icon-button" type="button" onClick={close} disabled={busy} aria-label="关闭电影卡片"><X size={17} aria-hidden="true" /></button></div>
    <div className="movie-card-body">{entity.overview ? <div className="movie-card-field"><small>简介</small><p>{entity.overview}</p></div> : null}<div className="movie-card-ratings">{entity.doubanRating === undefined ? null : <span><Star size={14} aria-hidden="true" />豆瓣 {entity.doubanRating}</span>}<label><span>我的评分</span><input type="number" min="0" max="10" step="0.5" disabled={busy} value={rating} onChange={(event) => setRating(event.target.value)} aria-label="我的评分" /></label></div><label className="movie-card-field"><span>短评</span><textarea rows={3} disabled={busy} value={review} onChange={(event) => setReview(event.target.value)} aria-label="电影短评" /></label>{entity.externalIds ? <div className="movie-card-external"><small>外部 ID</small><span>{entity.externalIds.tmdb ? `TMDb ${entity.externalIds.tmdb}` : null}{entity.externalIds.imdb ? `IMDb ${entity.externalIds.imdb}` : null}{entity.externalIds.douban ? `豆瓣 ${entity.externalIds.douban}` : null}</span></div> : null}{error ? <p className="movie-panel-error" role="alert">{error}</p> : null}</div>
    <div className="dialog-footer"><button className="secondary-button" type="button" onClick={close} disabled={busy}>关闭</button><button className="primary-button" type="button" onClick={() => void save()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存评分与短评"}</span></button></div>
  </dialog>;
}

/**
 * The in-timeline way in. It used to be an underlined "电影" word behind a
 * two-step popover, and it only ever appeared when the prose literally said
 * 「电影」 — in 93 records that condition matched once. Now it is the same capsule
 * the title itself would wear, one click from the panel, and it carries the
 * title from 《…》 straight into the search box.
 */
export function MoviePrompt({ enabled, initialQuery, onAttach, onSuppress }: { readonly enabled: boolean; readonly initialQuery?: string; readonly onAttach: (movie: MovieEntity) => void; readonly onSuppress: () => void }) {
  const [open, setOpen] = useState(false);
  const promptRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !promptRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  if (!enabled) return null;
  return <span ref={promptRef} className="movie-prompt-wrap"><button className="movie-prompt-trigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={initialQuery ? `识别影片：${initialQuery}` : "添加这部影片"}><Film size={13} strokeWidth={1.9} aria-hidden="true" />{initialQuery ? "识别影片" : "添加影片"}</button>{open ? <span className="movie-prompt-popover" role="dialog" aria-label="识别影片"><MovieAddPanel enabled={enabled} compact initialQuery={initialQuery} onAttach={(movie) => { onAttach(movie); setOpen(false); }} onClose={() => setOpen(false)} onSuppress={() => { onSuppress(); setOpen(false); }} /></span> : null}</span>;
}

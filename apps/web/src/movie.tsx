import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, Film, LoaderCircle, PlugZap, Search, Star, X } from "lucide-react";
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
  return {
    id,
    type: "movie",
    name,
    ...(aliases === undefined || aliases.length === 0 ? {} : { aliases }),
    ...(stringValue(nested.originalTitle) === undefined ? {} : { originalTitle: stringValue(nested.originalTitle) }),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(posterUrl === undefined ? {} : { posterUrl }),
    ...(overview === undefined ? {} : { overview }),
    ...(externalIds === undefined ? {} : { externalIds }),
    ...(numberValue(nested.doubanRating) === undefined ? {} : { doubanRating: numberValue(nested.doubanRating) }),
    ...(numberValue(nested.personalRating) === undefined ? {} : { personalRating: numberValue(nested.personalRating) }),
    ...(personalReview === undefined ? {} : { personalReview }),
    ...(watchedAt === undefined ? {} : { watchedAt }),
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
  return { enabled, configured, keyConfigured, connected, ...(provider === undefined ? {} : { provider }), ...(message === undefined ? {} : { message }) };
}

export async function fetchMovieModuleStatus(): Promise<MovieModuleStatus> {
  return normalizeStatus(await requestMovie<MovieModulePayload>(MOVIE_ENDPOINTS.status));
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
  const payload = await requestMovie<unknown>(MOVIE_ENDPOINTS.upsert, { method: "POST", body: JSON.stringify(movie) });
  return normalizeMovie(payload) ?? movie;
}

export function movieRef(movie: MovieEntity): MovieEntityRef {
  return { entityType: "movie", entityId: movie.id, label: movie.name };
}

function movieMeta(movie: Pick<MovieEntity, "originalTitle" | "releaseYear">): string {
  return [movie.originalTitle, movie.releaseYear === undefined ? undefined : String(movie.releaseYear)].filter(Boolean).join(" · ");
}

function moviePoster(movie: Pick<MovieEntity, "posterUrl">): string | undefined {
  const value = movie.posterUrl?.trim();
  return value ? value : undefined;
}

export function MovieSettingsCard({ status, onChanged }: { readonly status: MovieModuleStatus; readonly onChanged: (status: MovieModuleStatus) => void }) {
  const [enabled, setEnabled] = useState(status.enabled);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setEnabled(status.enabled), [status.enabled]);
  const save = async () => {
    if (busy || testing) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const next = await saveMovieModuleConfig(enabled, apiKey);
      setApiKey(""); onChanged(next); setMessage(enabled ? "观影模块已保存" : "观影模块已关闭，已保存影片仍会保留");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "观影模块保存失败，请重试"); }
    finally { setBusy(false); }
  };
  const test = async () => {
    if (busy || testing) return;
    setTesting(true); setMessage(null); setError(null);
    try { const result = await testMovieModule(apiKey); onChanged({ ...status, enabled, connected: true, configured: status.configured || Boolean(apiKey.trim()), keyConfigured: status.keyConfigured || Boolean(apiKey.trim()) }); setMessage(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "TMDb 连接失败，请检查 Key"); }
    finally { setTesting(false); }
  };
  const stateLabel = !status.enabled ? "已关闭" : status.connected ? "已连接" : status.keyConfigured ? "待测试" : "未配置";
  return <div className="settings-card movie-settings-card" data-movie-settings>
    <div className="movie-settings-head"><div className="settings-card-icon movie-icon"><Film size={18} aria-hidden="true" /></div><div className="settings-card-copy"><strong>观影模块</strong><small>可选 · TMDb 仅用于识别，豆瓣链接只保存为外部 ID</small></div><span className={`settings-status ${status.enabled && status.connected ? "is-ready" : ""}`}>{stateLabel}</span></div>
    <div className="movie-settings-fields">
      {/* 这一行**只能**吃 `.movie-enabled-toggle`（原生 checkbox + 文字的一整行）。
          绝不能同时挂 `.settings-switch` —— 那是另一套设计（44×26 的假药丸，把 `input`
          绝对定位成 1px + `opacity:0`，靠 `span` 画滑块）。两套一起挂的实测后果：
          整行被钉成 44×26、假药丸被 `display:none` 干掉、原生 checkbox 被 `opacity:0` 干掉
          ⇒ 一个可勾的东西都没有；「启用观影模块」七个字挤进 22px 宽、竖着堆成 8 行（高 96px）、
          上下各溢出 28px。守它的是 `.review/verify-movie-toggle-ui.mjs`。 */}
      <label className="movie-enabled-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} aria-label="启用观影模块" /><span aria-hidden="true" /><strong>启用观影模块</strong></label>
      <label><span>TMDb Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status.keyConfigured ? "已保存，留空不变" : "填写 TMDb API Key"} autoComplete="new-password" /></label>
    </div>
    <div className="movie-settings-actions"><button className="icon-text-button" type="button" onClick={() => void test()} disabled={busy || testing}>{testing ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <PlugZap size={15} aria-hidden="true" />}<span>{testing ? "测试中…" : "测试连接"}</span></button><button className="primary-button" type="button" onClick={() => void save()} disabled={busy || testing}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存配置"}</span></button></div>
    {message ? <p className="settings-inline-success" role="status">{message}</p> : null}{error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
    <p className="movie-settings-note">Key 只提交到 API 服务端，不进入 localStorage，也不会回显。</p>
  </div>;
}

interface MovieAddPanelProps {
  readonly enabled: boolean;
  readonly onAttach: (movie: MovieEntity) => void;
  readonly onClose?: () => void;
  readonly compact?: boolean;
}

export function MovieAddPanel({ enabled, onAttach, onClose, compact = false }: MovieAddPanelProps) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<readonly MovieResolveCandidate[]>([]);
  const [selected, setSelected] = useState<MovieResolveCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const resolve = async (event: FormEvent) => {
    event.preventDefault();
    if (!enabled || busy || !query.trim()) return;
    setBusy(true); setError(null); setMessage(null); setSelected(null);
    try {
      const next = await resolveMovie(query);
      setCandidates(next);
      if (next.length === 0) setMessage("没有找到匹配影片，请换一个片名或链接");
    } catch (cause) { setCandidates([]); setError(cause instanceof Error ? cause.message : "识别失败，请检查观影模块配置"); }
    finally { setBusy(false); }
  };
  const attach = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(null); setMessage(null);
    try { const movie = await importMovie(selected); onAttach(movie); setCandidates([]); setSelected(null); setQuery(""); setMessage("影片已加入这条记录"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "影片保存失败，请重试"); }
    finally { setBusy(false); }
  };
  return <div className={`movie-add-panel ${compact ? "is-compact" : ""}`} data-movie-add-panel>
    <div className="movie-add-heading"><div><strong>添加电影</strong><small>豆瓣链接、IMDb tt、TMDb ID 或片名</small></div>{onClose ? <button type="button" className="icon-button compact-icon-button" onClick={onClose} aria-label="关闭添加电影"><X size={15} aria-hidden="true" /></button> : null}</div>
    {!enabled ? <p className="movie-panel-muted">请先在设置中启用观影模块。</p> : <>
      <form className="movie-resolve-form" onSubmit={resolve}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入电影名 / 链接 / ID" aria-label="电影识别内容" autoFocus={!compact} /><button className="secondary-button" type="submit" disabled={!query.trim() || busy}>{busy ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <Search size={15} aria-hidden="true" />}<span>{busy ? "识别中…" : "识别"}</span></button></form>
      {candidates.length > 0 ? <div className="movie-candidates" role="listbox" aria-label="电影候选"><p className="movie-candidates-hint">找到 {candidates.length} 个候选，请点选后添加</p>{candidates.map((candidate) => { const meta = movieMeta(candidate); return <button className={`movie-candidate ${selected?.id === candidate.id ? "is-selected" : ""}`} data-movie-candidate={candidate.id} type="button" role="option" aria-selected={selected?.id === candidate.id} key={candidate.id} onClick={() => setSelected(candidate)}>{moviePoster(candidate) ? <img src={moviePoster(candidate)} alt="" loading="lazy" /> : <span className="movie-candidate-fallback" aria-hidden="true"><Film size={16} /></span>}<span><strong>{candidate.name}</strong>{meta ? <small>{meta}</small> : null}{candidate.overview ? <em>{candidate.overview}</em> : null}</span></button>; })}</div> : null}
      {selected ? <div className="movie-add-selected"><span>已选择：{selected.name}</span><button className="primary-button" type="button" onClick={() => void attach()} disabled={busy}>{busy ? "保存中…" : "添加到记录"}</button></div> : null}
      {message ? <p className="movie-panel-message" role="status">{message}</p> : null}{error ? <p className="movie-panel-error" role="alert">{error}</p> : null}
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
  return <dialog ref={dialogRef} className="modal-dialog movie-card-dialog" data-movie-card={entity.id} aria-labelledby="movie-card-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClose={onClose}>
    <div className="movie-card-hero">{poster ? <img className="movie-card-poster" src={poster} alt={`${entity.name} 海报`} onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <div className="movie-card-poster movie-card-poster-fallback" aria-hidden="true"><Film size={29} /></div>}<div className="movie-card-heading"><p className="eyebrow">电影卡片</p><h2 id="movie-card-title">《{entity.name}》</h2>{movieMeta(entity) ? <p>{movieMeta(entity)}</p> : null}{entity.watchedAt ? <small>观看于 {entity.watchedAt.slice(0, 10)}</small> : null}</div><button className="icon-button compact-icon-button" type="button" onClick={onClose} aria-label="关闭电影卡片"><X size={17} aria-hidden="true" /></button></div>
    <div className="movie-card-body">{entity.overview ? <div className="movie-card-field"><small>简介</small><p>{entity.overview}</p></div> : null}<div className="movie-card-ratings">{entity.doubanRating === undefined ? null : <span><Star size={14} aria-hidden="true" />豆瓣 {entity.doubanRating}</span>}<label><span>我的评分</span><input type="number" min="0" max="10" step="0.5" value={rating} onChange={(event) => setRating(event.target.value)} aria-label="我的评分" placeholder="— / 10" /></label></div><label className="movie-card-field"><span>短评</span><textarea rows={3} value={review} onChange={(event) => setReview(event.target.value)} placeholder="写一句看完后的感受" aria-label="电影短评" /></label>{entity.externalIds ? <div className="movie-card-external"><small>外部 ID</small><span>{entity.externalIds.tmdb ? `TMDb ${entity.externalIds.tmdb}` : null}{entity.externalIds.imdb ? `IMDb ${entity.externalIds.imdb}` : null}{entity.externalIds.douban ? `豆瓣 ${entity.externalIds.douban}` : null}</span></div> : null}{error ? <p className="movie-panel-error" role="alert">{error}</p> : null}</div>
    <div className="dialog-footer"><button className="secondary-button" type="button" onClick={onClose}>关闭</button><button className="primary-button" type="button" onClick={() => void save()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}<span>{busy ? "保存中…" : "保存评分与短评"}</span></button></div>
  </dialog>;
}

export function MoviePrompt({ enabled, onAttach, onSuppress }: { readonly enabled: boolean; readonly onAttach: (movie: MovieEntity) => void; readonly onSuppress: () => void }) {
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  if (!enabled) return null;
  return <span className="movie-prompt-wrap"><button className="movie-prompt-trigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>电影</button>{open ? <span className="movie-prompt-popover" role="dialog" aria-label="添加影片提示"><span className="movie-prompt-actions"><button type="button" onClick={() => setAddOpen(true)}>添加影片</button><button type="button" onClick={() => { onSuppress(); setOpen(false); }}>不再提示</button></span>{addOpen ? <MovieAddPanel enabled={enabled} compact onAttach={(movie) => { onAttach(movie); setAddOpen(false); setOpen(false); }} onClose={() => setAddOpen(false)} /> : null}</span> : null}</span>;
}

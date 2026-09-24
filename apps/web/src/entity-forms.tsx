import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { LoaderCircle, MapPin, Plus, User, X } from "lucide-react";
import { PLACE_MARKER, PLACE_ROLES, entitySearchTerms, normalizeEntitySearchTerm, type PlacePeriod, type PlaceRole } from "@lifeos/core";
import type { Entity } from "@lifeos/core";
import type { CreateEntity, EntityCreateRequest } from "./app-types";
import type { ModuleCommand } from "./movie";
import {
  CJK_PATTERN,
  MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH,
  ENTITY_META,
  isMovieEntity,
} from "./app-meta";
import {
  entityHint,
  hasKnownMentionPrefix,
  mentionQueryAt,
  mentionSuggestions,
  slashQueryAt,
  slashSuggestions,
  PLACE_ROLE_LABELS,
  type MentionQuery,
  type SlashQuery,
} from "./mention";
import { slashSuggestions as slashSuggestionsFn } from "./mention";
import { clampFixedMenuPosition } from "./menu-position";

/**
 * One entry in the right-click menu. The menu is generic on purpose: the box
 * knows how to read a selection and draw a list, and the caller knows what the
 * text means. `hint` is the second line — while the action is usable it says
 * what will actually be searched for, and when it is not, it says why. That
 * line is the whole reason the cleaning step is visible instead of silent.
 */
export interface ContextAction {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly onSelect: (text: string) => void;
}

export interface MentionBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly entities: readonly Entity[];
  readonly recentPlaceIds?: readonly string[];
  readonly onCreateEntity: CreateEntity;
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
  readonly className?: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly ariaLabel: string;
  readonly autoFocus?: boolean;
  readonly autoGrow?: boolean;
  readonly autoGrowRows?: number;
  readonly moduleCommands?: readonly ModuleCommand[];
  readonly onSlashCommand?: (command: ModuleCommand) => void;
  /**
   * Builds the right-click menu for a selection. Omitted means "no menu" and the
   * browser's own one is left alone, which is what every other box wants. It is
   * a function rather than a list because the caller needs the selected text to
   * decide what the entries say.
   */
  readonly contextActions?: (text: string) => readonly ContextAction[];
}

/**
 * The create form behind "新建" — type is switchable, and a place collects its
 * role and period right here, so nobody ever gets filed under the wrong kind
 * again. Marker characters are stripped from the name: an entity literally
 * named "@老王" would be unmentionable forever.
 */
/**
 * One alias field, split on `/`.
 *
 * The separator used to be a comma, and that was a coin flip: half the world
 * types `,` and half types `，`, and whichever one you did not handle silently
 * welded two aliases into one. A slash has no such twin — there is one slash on
 * a keyboard — so it is the one delimiter that cannot be typed "wrong".
 *
 * The split is shown as it happens. Every segment that has been closed off by a
 * slash lights up as its own chip, so the field answers "did that register?"
 * while it is being typed rather than at save time. A run with no separator in
 * it stays unlit as one long block, which is exactly what it is — and seeing
 * "王后广场皇后广场天后广场" sitting there as a single slab is the tell that the
 * slashes are missing, without anything having to say so in words.
 */
export function AliasField({ value, onChange, label, placeholder, compact = false }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string; compact?: boolean }) {
  const segments = parseAliasSegments(value);
  const chips = segments.filter((segment) => segment.complete);
  // A segment can be "complete" by the slash rule and still be obviously wrong:
  // two aliases glued together is a longer run than any alias should be, and a
  // comma inside one means somebody used the separator this field no longer
  // takes. Both are flagged rather than quietly accepted, because the whole
  // point of showing the split is to catch it now instead of at save time.
  const suspect = chips.some(isSuspectAlias);
  return <div className={`alias-field ${compact ? "is-compact" : ""}`}>
    <input
      className={compact ? "alias-input" : "entity-create-input alias-input"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder ?? "可选，用 / 分隔，例如：家 / 老宅"}
      aria-label={label}
    />
    {/* Only rendered once there is something to confirm -- an empty ruler under
        an empty field would be noise. */}
    {chips.length > 0 ? <div className="alias-chips" data-alias-count={chips.length} data-alias-suspect={suspect ? "true" : "false"} aria-live="polite">
      {chips.map((segment) => <span className={`alias-chip ${isSuspectAlias(segment) ? "is-suspect" : ""}`} key={segment.start} title={isSuspectAlias(segment) ? "这一段看起来像两个别名粘在一起了，用 / 分开试试" : undefined}>{segment.text}</span>)}
      <span className="alias-chip-note">{suspect ? "是不是漏了 / ？" : `${chips.length} 个别名`}</span>
    </div> : null}
  </div>;
}

/**
 * Whether a finished-looking segment is probably two aliases that never got
 * separated.
 *
 * Two tells, both cheap and both reliable enough: a comma inside it (the old
 * separator, typed out of habit) or a length no single alias reaches. The length
 * bound is deliberately loose — place and person names in CJK are usually two to
 * six characters, and this fires at ten, so it only catches the obvious glue.
 */
const SUSPECT_ALIAS_LENGTH = 10;
function isSuspectAlias(segment: AliasSegment): boolean {
  return /[,，、;；]/.test(segment.text) || Array.from(segment.text).length >= SUSPECT_ALIAS_LENGTH;
}

interface AliasSegment { readonly text: string; readonly start: number; readonly complete: boolean; }

/**
 * Splits raw alias text into the runs between slashes, and says which of them
 * are finished.
 *
 * "Finished" means a slash closed it off, or it is the last run and no slash is
 * pending. So `家 / 老宅 /` has two finished aliases and an empty tail, while
 * `家 / 老宅` has two as well, and a bare `家老宅` is one unfinished run — the
 * case that should visibly not light up.
 *
 * Whitespace around a segment is trimmed but tolerated, because people type
 * `家 / 老宅` and mean two aliases, not one containing spaces.
 */
export function parseAliasSegments(raw: string): readonly AliasSegment[] {
  if (raw.trim().length === 0) return [];
  const parts = raw.split("/");
  const segments: AliasSegment[] = [];
  let cursor = 0;
  parts.forEach((part, index) => {
    const start = cursor;
    cursor += part.length + 1;
    const text = part.trim();
    // A trailing empty part means the string ended on a slash: nothing pending.
    const isLast = index === parts.length - 1;
    const complete = text.length > 0 && (!isLast || !raw.endsWith("/"));
    if (text.length > 0) segments.push({ text, start, complete });
  });
  return segments;
}

/**
 * The aliases an alias field actually holds, in order, deduplicated.
 *
 * The last run counts even without a closing slash — somebody who typed one
 * alias and stopped should not have to add a slash to prove it.
 */
export function aliasListFrom(raw: string): readonly string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const segment of parseAliasSegments(raw)) {
    if (seen.has(segment.text)) continue;
    seen.add(segment.text);
    list.push(segment.text);
  }
  return list;
}
export function EntityCreateForm({ defaultType, defaultName, onCreate, onCancel, submitLabel }: { defaultType: "person" | "place"; defaultName: string; onCreate: (request: EntityCreateRequest) => Promise<boolean>; onCancel: () => void; submitLabel: string }) {
  const [type, setType] = useState<"person" | "place">(defaultType);
  const [name, setName] = useState(defaultName);
  const [aliases, setAliases] = useState("");
  const [role, setRole] = useState<PlaceRole>("home");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const cleanName = name.replace(/[@#]/g, "").trim();
  const submit = async () => {
    if (cleanName.length === 0 || busy) return;
    const aliasList = aliasListFrom(aliases);
    setBusy(true);
    const created = await onCreate({
      type,
      name: cleanName,
      ...(aliasList.length > 0 ? { aliases: aliasList } : {}),
      ...(type === "place" ? { role } : {}),
      ...(type === "place" && (from !== "" || until !== "") ? { period: { ...(from === "" ? {} : { from }), ...(until === "" ? {} : { until }) } } : {}),
      ...(type === "place" && address.trim() ? { address: address.trim() } : {}),
    });
    setBusy(false);
    if (created) onCancel();
  };
  return <div className="entity-create-form" role="form" aria-label={`新建${type === "place" ? "地点" : "人物"}`}>
    <div className="entity-create-row">
      <span className="entity-create-label">类型</span>
      <div className="entity-create-types">
        <button type="button" className={`entity-type-option ${type === "person" ? "is-active" : ""}`} onClick={() => setType("person")}><User size={13} strokeWidth={1.8} aria-hidden="true" />人物</button>
        <button type="button" className={`entity-type-option ${type === "place" ? "is-active" : ""}`} onClick={() => setType("place")}><MapPin size={13} strokeWidth={1.8} aria-hidden="true" />地点</button>
      </div>
    </div>
    <div className="entity-create-row">
      <span className="entity-create-label">名称</span>
      <input className="entity-create-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="名称（@ # 符号会自动去掉）" autoFocus onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }} />
    </div>
    <div className="entity-create-row">
      <span className="entity-create-label">别名</span>
      <AliasField value={aliases} onChange={setAliases} label="别名，用斜杠分隔" />
    </div>
    {type === "place" ? <>
      <div className="entity-create-row">
        <span className="entity-create-label">角色</span>
        <div className="entity-create-types">
          {PLACE_ROLES.map((option) => <button key={option} type="button" className={`entity-type-option ${role === option ? "is-active" : ""}`} onClick={() => setRole(option)}>{PLACE_ROLE_LABELS[option]}</button>)}
        </div>
      </div>
      <div className="entity-create-row">
        <span className="entity-create-label">时期</span>
        <input className="entity-create-input entity-create-month" type="month" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="开始年月" />
        <span className="entity-create-label">至</span>
        <input className="entity-create-input entity-create-month" type="month" value={until} onChange={(event) => setUntil(event.target.value)} aria-label="结束年月，留空表示至今" />
      </div>
      <div className="entity-create-row">
        <span className="entity-create-label">详细地址</span>
        <input className="entity-create-input" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="可选；平时不会展开" />
      </div>
    </> : null}
    <div className="entity-create-actions">
      <button type="button" className="text-button" onClick={onCancel}>取消</button>
      <button type="button" className="primary-button entity-create-submit" disabled={cleanName.length === 0 || busy} onClick={() => void submit()}>{busy ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : null}<span>{submitLabel}</span></button>
    </div>
  </div>;
}

/**
 * A textarea that understands `@person` and `#place`. Typing a marker opens a
 * small list of known entities of the matching kind (searched across names
 * and aliases); picking one writes `标记名字` into the text, and the server
 * turns that mention into a real entityRef when the record is saved. Doubling
 * the marker (`##名字` / `@@名字`) opens the create form — type stays
 * switchable there, so a person can never be filed as a place by accident.
 * Unknown names are never rewritten, which is what keeps e-mail addresses,
 * passwords, and hex colours safe.
 */
export function MentionBox({ value, onChange, entities, recentPlaceIds = [], onCreateEntity, textareaRef, className, placeholder, rows = 3, ariaLabel, autoFocus, autoGrow, autoGrowRows, moduleCommands = [], onSlashCommand, contextActions }: MentionBoxProps) {
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? localRef;
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [createFormOpen, setCreateFormOpen] = useState(false);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; text: string; actions: readonly ContextAction[] } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [contextPosition, setContextPosition] = useState({ x: 0, y: 0 });
  // A right-click outside the selection collapses it before `contextmenu`
  // arrives, so the range is copied on the way down as well. Inside the
  // selection the live range still wins, which keeps a stale copy from ever
  // acting on text the owner has since moved away from.
  const pressedRange = useRef<{ start: number; end: number } | null>(null);
  const slashOptions = useMemo(() => slash === null ? [] : slashSuggestions(moduleCommands, slash.query), [moduleCommands, slash]);
  const suggestions = useMemo(() => (mention === null || createFormOpen ? [] : mentionSuggestions(entities, mention.marker, mention.query, recentPlaceIds)), [entities, mention, createFormOpen, recentPlaceIds]);
  const trimmedQuery = mention?.query.trim() ?? "";
  const hasKnownPrefix = mention !== null && hasKnownMentionPrefix(entities, mention.marker, mention.query);
  const markerKind = mention?.marker === PLACE_MARKER ? "place" : "person";
  const kindLabel = markerKind === "place" ? "地点" : "人物";
  // The list opens for a real match, or for something that reads like a name.
  // A password or API token typed after @ stays plain text and never offers to
  // create a person out of it. A doubled marker skips the known list entirely
  // and opens the create form, where the type is switchable before anything
  // is written.
  const wantsNew = trimmedQuery.length > 0 && !hasKnownPrefix && (mention?.forceNew === true ||
    (CJK_PATTERN.test(trimmedQuery) && Array.from(trimmedQuery).length <= MAX_IMPLICIT_CJK_MENTION_NAME_LENGTH && !suggestions.some((entity) => entitySearchTerms(entity).some((term) => normalizeEntitySearchTerm(term) === normalizeEntitySearchTerm(trimmedQuery)))));
  const optionCount = createFormOpen ? 0 : (mention?.forceNew === true ? 0 : suggestions.length) + (wantsNew ? 1 : 0);

  useEffect(() => { setActiveIndex(0); }, [mention?.start, mention?.query, slash?.start, slash?.query]);
  // The list reopens on its first row, and stays there until the owner moves it.
  // The clamp is a guard, not a feature: the option count can shrink under a
  // selection (a filter tightening, the create row dropping away) and an index
  // past the end would silently make Enter do nothing.
  const safeIndex = optionCount === 0 ? 0 : Math.min(activeIndex, optionCount - 1);

  const syncMention = (element: HTMLTextAreaElement) => {
    setMention(mentionQueryAt(element.value, element.selectionStart ?? element.value.length));
    setSlash(slashQueryAt(element.value, element.selectionStart ?? element.value.length));
  };

  useEffect(() => {
    if (slash === null) return undefined;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.parentElement?.contains(target) !== true) setSlash(null);
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer);
  }, [slash]);

  // Same dismissal contract as the calendar's summary menu: a pointer down
  // outside, Escape, or a scroll takes it away. Picking an entry closes it too,
  // and that has to happen in the entry's own click — a press inside the panel
  // stops its `pointerdown` from ever reaching this window listener.
  useEffect(() => {
    if (contextMenu === null) return undefined;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (contextMenu === null || menu === null) return;
    const rect = menu.getBoundingClientRect();
    setContextPosition(clampFixedMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height, window.innerWidth, window.innerHeight));
  }, [contextMenu]);

  const openContextMenu = (element: HTMLTextAreaElement, clientX: number, clientY: number): boolean => {
    if (contextActions === undefined) return false;
    const start = element.selectionStart ?? 0;
    const end = element.selectionEnd ?? 0;
    const range = end > start ? { start, end } : pressedRange.current;
    if (range === null) return false;
    const text = element.value.slice(range.start, range.end);
    if (text.trim().length === 0) return false;
    const actions = contextActions(text);
    if (actions.length === 0) return false;
    setContextMenu({ x: clientX, y: clientY, text, actions });
    return true;
  };

  const insert = (name: string, markerOverride?: string) => {
    if (mention === null) return;
    const inserted = `${markerOverride ?? mention.marker}${name}`;
    const nextValue = `${value.slice(0, mention.start)}${inserted}${value.slice(mention.end)}`;
    const caret = mention.start + inserted.length;
    onChange(nextValue);
    setMention(null);
    setCreateFormOpen(false);
    window.requestAnimationFrame(() => {
      const element = ref.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  const submitCreateForm = async (request: EntityCreateRequest): Promise<boolean> => {
    if (mention === null) return false;
    const entity = await onCreateEntity(request.type, request.name, {
      ...(request.aliases === undefined ? {} : { aliases: request.aliases }),
      ...(request.role === undefined ? {} : { role: request.role }),
      ...(request.period === undefined ? {} : { period: request.period }),
      ...(request.address === undefined ? {} : { address: request.address }),
    });
    if (entity === null) return false;
    // The form decides the kind last — a ## trigger that was switched to a
    // person must still insert as @.
    insert(entity.name, request.type === "place" ? PLACE_MARKER : "@");
    return true;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (slash !== null) {
      if (slashOptions.length === 0) {
        if (event.key === "Escape") { event.preventDefault(); setSlash(null); }
      } else {
        if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => (current + 1) % slashOptions.length); return; }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => (current - 1 + slashOptions.length) % slashOptions.length); return; }
        if (event.key === "Escape") { event.preventDefault(); setSlash(null); return; }
        if (event.key === "Enter") {
          event.preventDefault();
          const command = slashOptions[activeIndex];
          if (command) {
            const next = `${value.slice(0, slash.start)}${value.slice(slash.end)}`;
            onChange(next);
            setSlash(null);
            setMention(null);
            onSlashCommand?.(command);
            window.requestAnimationFrame(() => {
              const element = ref.current;
              if (!element) return;
              element.focus();
              element.setSelectionRange(slash.start, slash.start);
            });
          }
          return;
        }
      }
    }
    if (mention === null || optionCount === 0) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => (current + 1) % optionCount); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => (current - 1 + optionCount) % optionCount); return; }
    if (event.key === "Escape") { event.preventDefault(); setMention(null); setCreateFormOpen(false); return; }
    // Enter and Space both take the highlighted option. Space is not a typo
    // for Enter -- the picker opens with its first row already highlighted, so
    // the fastest path through it is "@王后" then space then straight on with
    // the sentence, and the space that committed is not left behind in the
    // text. Escape is the only way out without choosing.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (createFormOpen || mention.forceNew === true) { setCreateFormOpen(true); return; }
      const target = suggestions[safeIndex];
      if (target) insert(target.name);
      else setCreateFormOpen(true);
    }
  };

  // Grow once, smoothly, when the text would overflow 90% of the collapsed
  // height; shrink back when the content fits again. Height is driven inline
  // here because scrollHeight never reads smaller than the element itself.
  const collapsedRef = useRef(0);
  useEffect(() => {
    if (!autoGrow) return;
    const element = ref.current;
    if (element === null) return;
    const style = window.getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight) || 21;
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    collapsedRef.current = lineHeight * (autoGrowRows ?? rows) + padding;
    element.style.setProperty("min-height", "0px", "important");
    element.style.height = `${collapsedRef.current}px`;
  }, [autoGrow, autoGrowRows, rows, ref]);
  useEffect(() => {
    if (!autoGrow) return;
    const element = ref.current;
    if (element === null || collapsedRef.current === 0) return;
    const collapsed = collapsedRef.current;
    // Content height comes from a hidden, same-width copy, so the live element
    // never has to change height for a measurement. Touching the live height
    // here used to make the box bounce on every keystroke: reading
    // clientWidth flushes style, a transient "0px" got snapshotted as the
    // computed value, and restoring the height then re-ran the 260ms height
    // transition from zero on every keystroke.
    const measurement = element.cloneNode(false) as HTMLTextAreaElement;
    measurement.value = element.value;
    measurement.rows = 1;
    measurement.style.position = "absolute";
    measurement.style.visibility = "hidden";
    measurement.style.pointerEvents = "none";
    measurement.style.height = "auto";
    measurement.style.minHeight = "0px";
    measurement.style.width = `${element.clientWidth}px`;
    measurement.style.overflow = "hidden";
    document.body.appendChild(measurement);
    const contentHeight = measurement.scrollHeight;
    measurement.remove();
    const target = contentHeight > collapsed * 0.9 ? collapsed * 2 : collapsed;
    element.style.height = `${target}px`;
  }, [autoGrow, value, ref]);

  return <div className="mention-box">
    <textarea ref={ref} className={className} value={value} autoFocus={autoFocus} rows={rows} placeholder={placeholder} aria-label={ariaLabel} onChange={(event) => { onChange(event.target.value); syncMention(event.target); }} onKeyDown={handleKeyDown} onClick={(event) => syncMention(event.currentTarget)} onMouseDown={(event) => { const element = event.currentTarget; if (event.button !== 2) { pressedRange.current = null; return; } const start = element.selectionStart ?? 0; const end = element.selectionEnd ?? 0; pressedRange.current = end > start ? { start, end } : null; }} onContextMenu={(event) => { if (openContextMenu(event.currentTarget, event.clientX, event.clientY)) event.preventDefault(); }} onKeyUp={(event) => { if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") syncMention(event.currentTarget); }} />
    {contextMenu !== null ? <div ref={contextMenuRef} className="mention-context-menu" role="menu" aria-label="选中文字的操作" style={{ left: contextPosition.x, top: contextPosition.y }} onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.preventDefault()}>{contextMenu.actions.map((action) => <button className={action.disabled === true ? "is-disabled" : ""} role="menuitem" type="button" aria-disabled={action.disabled === true} key={action.id} onClick={() => { const text = contextMenu.text; setContextMenu(null); if (action.disabled !== true) action.onSelect(text); }}><span className="mention-context-label">{action.label}</span>{action.hint ? <small>{action.hint}</small> : null}</button>)}</div> : null}
    {slash !== null && slashOptions.length > 0 ? <div className="slash-suggest" role="listbox" aria-label="模块命令">{slashOptions.map((command, index) => <button className={`slash-option ${index === activeIndex ? "is-active" : ""}`} type="button" role="option" aria-selected={index === activeIndex} key={command.id} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => { const next = `${value.slice(0, slash.start)}${value.slice(slash.end)}`; onChange(next); setSlash(null); setMention(null); onSlashCommand?.(command); window.requestAnimationFrame(() => { const element = ref.current; if (element) { element.focus(); element.setSelectionRange(slash.start, slash.start); } }); }}><span className="slash-option-label">{command.label}</span><small>{command.aliases.length > 0 ? `${command.aliases.join("、")} · ` : ""}{command.description}</small></button>)}</div> : null}
    {mention !== null && (createFormOpen || mention.forceNew === true) ? <EntityCreateForm defaultType={markerKind} defaultName={trimmedQuery} onCreate={submitCreateForm} onCancel={() => { setCreateFormOpen(false); setMention(null); }} submitLabel={`创建并插入 ${mention.marker}`} /> : null}
    {mention !== null && !createFormOpen && mention.forceNew !== true && optionCount > 0 ? <div className="mention-suggest" role="listbox" aria-label="选择要关联的对象">
      {suggestions.map((entity, index) => <button className={`mention-option ${index === safeIndex ? "is-active" : ""}`} key={entity.id} type="button" role="option" aria-selected={index === safeIndex} onMouseEnter={() => setActiveIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(entity.name)}>{(() => { const KindIcon = ENTITY_META[entity.type].icon; return <KindIcon size={13} strokeWidth={1.8} aria-hidden="true" />; })()}<span className="mention-option-name">{entity.name}</span><small>{entityHint(entity)}</small></button>)}
      {wantsNew ? <button className="mention-option mention-option-create" type="button" role="option" aria-selected={safeIndex === suggestions.length} onMouseEnter={() => setActiveIndex(suggestions.length)} onMouseDown={(event) => event.preventDefault()} onClick={() => setCreateFormOpen(true)}><Plus size={13} aria-hidden="true" /><span className="mention-option-name">新建{kindLabel}「{trimmedQuery}」…</span></button> : null}
    </div> : null}
  </div>;
}

import { DiagnosticsDrawer, EmptyState, ErrorState, LoadingState } from "./timeline-states";

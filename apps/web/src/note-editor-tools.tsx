import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Check, ChevronDown, Code2, Columns3, Eraser, Heading, Highlighter, Italic, Link2, List, ListOrdered, Minus, MoreHorizontal, Paintbrush, PanelBottomOpen, PanelLeftOpen, PanelRightOpen, PanelTopOpen, Quote, Redo2, Rows3, Strikethrough, Table2, Trash2, Undo2, Underline, Unlink2, ImagePlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Editor } from './penmark/editor.js';
import './note-editor-tools.css';
import { useActionMenu } from './action-menu';

type ToolKey = 'heading' | 'bold' | 'italic' | 'underline' | 'unordered' | 'ordered' | 'image' | 'strike' | 'highlight' | 'align-left' | 'align-center' | 'align-right' | 'align-justify' | 'todo' | 'quote' | 'inline-code' | 'code-block' | 'table' | 'rule' | 'clear' | 'paint' | 'link' | 'undo' | 'redo';

type ToolDefinition = {
  key: ToolKey;
  label: string;
  icon: LucideIcon;
  width?: number;
  priority?: number;
};

const MAIN_TOOLS: readonly ToolDefinition[] = [
  { key: 'heading', label: '段落样式', icon: Heading, width: 86, priority: 0 },
  { key: 'bold', label: '加粗', icon: Bold, priority: 1 },
  { key: 'italic', label: '斜体', icon: Italic, priority: 2 },
  { key: 'underline', label: '下划线', icon: Underline, priority: 3 },
  { key: 'unordered', label: '无序列表', icon: List, priority: 4 },
  { key: 'image', label: '插入图片', icon: ImagePlus, priority: 5 },
  { key: 'ordered', label: '有序列表', icon: ListOrdered, priority: 6 },
];

const MORE_TOOLS: readonly ToolDefinition[] = [
  { key: 'strike', label: '删除线', icon: Strikethrough },
  { key: 'highlight', label: '高亮', icon: Highlighter },
  { key: 'link', label: '插入链接', icon: Link2 },
  { key: 'undo', label: '撤销', icon: Undo2 },
  { key: 'redo', label: '重做', icon: Redo2 },
  { key: 'align-left', label: '左对齐', icon: AlignLeft },
  { key: 'align-center', label: '居中对齐', icon: AlignCenter },
  { key: 'align-right', label: '右对齐', icon: AlignRight },
  { key: 'align-justify', label: '两端对齐', icon: AlignJustify },
  { key: 'todo', label: '待办', icon: Check },
  { key: 'quote', label: '引用', icon: Quote },
  { key: 'inline-code', label: '行内代码', icon: Code2 },
  { key: 'code-block', label: '代码块', icon: Code2 },
  { key: 'table', label: '插入表格', icon: Table2 },
  { key: 'rule', label: '分隔线', icon: Minus },
  { key: 'clear', label: '清除格式', icon: Eraser },
  { key: 'paint', label: '格式刷', icon: Paintbrush },
];

const ALL_TOOLS = [...MAIN_TOOLS, ...MORE_TOOLS];

type FormatState = {
  block: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  unordered: boolean;
  ordered: boolean;
  quote: boolean;
  inlineCode: boolean;
  codeBlock: boolean;
  link: boolean;
  align: 'left' | 'center' | 'right' | 'justify' | '';
};

type TableBarState = {
  table: HTMLTableElement;
  canMerge: boolean;
  canSplit: boolean;
  selectedCount: number;
  rect: DOMRect;
};

type InlineBrush = {
  commands: readonly ('bold' | 'italic' | 'underline' | 'strikeThrough' | 'insertCodeInline')[];
  color?: string;
  highlight?: string;
  sourceRange: Range;
};

const EMPTY_FORMAT: FormatState = {
  block: 'p', bold: false, italic: false, underline: false, strike: false,
  highlight: false, unordered: false, ordered: false, quote: false,
  inlineCode: false, codeBlock: false, link: false, align: '',
};

const TOOL_GAP = 2;
const TOOL_BUTTON_WIDTH = 34;

function selectionRange(editor: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range : null;
}

function elementForNode(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function closestWithin(node: Node | null, selector: string, root: HTMLElement): Element | null {
  let element = elementForNode(node);
  while (element && element !== root) {
    if (element.matches(selector)) return element;
    element = element.parentElement;
  }
  return null;
}

function isCommandOn(command: string): boolean {
  try { return document.queryCommandState(command); } catch { return false; }
}

function getFormatState(editor: HTMLElement): FormatState {
  const range = selectionRange(editor);
  if (!range) return EMPTY_FORMAT;
  const node = range.startContainer;
  let block = closestWithin(node, 'h1,h2,h3,h4,p,blockquote,pre,li', editor);
  if (block?.tagName === 'LI') block = block.closest('ol,ul') ?? block;
  const tag = block?.tagName.toLowerCase() ?? 'p';
  let align: FormatState['align'] = '';
  if (isCommandOn('justifyLeft')) align = 'left';
  else if (isCommandOn('justifyCenter')) align = 'center';
  else if (isCommandOn('justifyRight')) align = 'right';
  else if (isCommandOn('justifyFull')) align = 'justify';
  return {
    block: /^h[1-4]$/.test(tag) ? tag : 'p',
    bold: isCommandOn('bold'), italic: isCommandOn('italic'), underline: isCommandOn('underline'),
    strike: isCommandOn('strikeThrough'),
    highlight: !!closestWithin(node, 'mark', editor) || hasVisibleInlineBackground(node, editor),
    unordered: !!closestWithin(node, 'ul', editor), ordered: !!closestWithin(node, 'ol', editor),
    quote: !!closestWithin(node, 'blockquote', editor), inlineCode: !!closestWithin(node, 'code', editor),
    codeBlock: !!closestWithin(node, 'pre', editor), link: !!closestWithin(node, 'a[href]', editor), align,
  };
}

function hasVisibleInlineBackground(node: Node, editor: HTMLElement): boolean {
  let element = elementForNode(node);
  while (element && element !== editor) {
    const background = (element as HTMLElement).style?.backgroundColor;
    if (background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') return true;
    element = element.parentElement;
  }
  return false;
}

function selectedRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 || rect.height > 0);
  return rects[0] ?? range.getBoundingClientRect();
}

function pointStyle(rect: DOMRect, width: number, height: number, preferAbove = true): CSSProperties {
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const above = rect.top - height - 8;
  const below = rect.bottom + 8;
  const top = preferAbove && above >= 8 ? above : below + height <= window.innerHeight - 8 ? below : Math.max(8, above);
  return { left, top };
}

function allocateVisibleTools(width: number): Set<ToolKey> {
  const total = MAIN_TOOLS.reduce((sum, tool) => sum + (tool.width ?? TOOL_BUTTON_WIDTH), 0) + TOOL_GAP * MAIN_TOOLS.length + TOOL_BUTTON_WIDTH;
  if (width >= total) return new Set(MAIN_TOOLS.map(tool => tool.key));
  let remaining = Math.max(0, width - TOOL_BUTTON_WIDTH - TOOL_GAP);
  let used = 0;
  const visible = new Set<ToolKey>();
  for (const tool of [...MAIN_TOOLS].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50))) {
    const cost = (tool.width ?? TOOL_BUTTON_WIDTH) + (used ? TOOL_GAP : 0);
    if (cost > remaining) continue;
    visible.add(tool.key);
    remaining -= cost;
    used += 1;
  }
  return visible;
}

function validCssColor(value: string | undefined): string | undefined {
  if (!value || /url\s*\(/i.test(value)) return undefined;
  const probe = document.createElement('span');
  probe.style.color = value;
  return probe.style.color || undefined;
}

function readInlineBrush(editor: HTMLElement): InlineBrush | null {
  const range = selectionRange(editor);
  if (!range || range.collapsed) return null;
  const start = elementForNode(range.startContainer);
  if (!start) return null;
  const chain: HTMLElement[] = [];
  let current: HTMLElement | null = start as HTMLElement;
  while (current && current !== editor) {
    chain.push(current);
    current = current.parentElement;
  }
  const tags = new Set(chain.map(element => element.tagName));
  const styles = chain.map(element => element.style);
  const commands: InlineBrush['commands'][number][] = [];
  if (tags.has('B') || tags.has('STRONG') || styles.some(style => Number.parseInt(style.fontWeight, 10) >= 600)) commands.push('bold');
  if (tags.has('I') || tags.has('EM') || styles.some(style => style.fontStyle === 'italic' || style.fontStyle === 'oblique')) commands.push('italic');
  if (tags.has('U') || styles.some(style => style.textDecorationLine.includes('underline') || style.textDecoration.includes('underline'))) commands.push('underline');
  if (tags.has('S') || tags.has('STRIKE') || tags.has('DEL') || styles.some(style => style.textDecorationLine.includes('line-through') || style.textDecoration.includes('line-through'))) commands.push('strikeThrough');
  if (tags.has('CODE')) commands.push('insertCodeInline');
  const color = styles.map(style => validCssColor(style.color)).find(Boolean);
  const explicitBackground = styles.map(style => validCssColor(style.backgroundColor)).find(Boolean);
  const highlight = tags.has('MARK') || explicitBackground ? explicitBackground ?? '#f4df9b' : undefined;
  if (!commands.length && !color && !highlight) return null;
  return { commands, color, highlight, sourceRange: range.cloneRange() };
}

function equalRange(a: Range, b: Range): boolean {
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

export function NoteEditorTools({ engine, surface, onImage, disabled = false, reading = false }: {
  engine: Editor | null;
  surface: HTMLElement | null;
  onImage: () => void;
  disabled?: boolean;
  reading?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mainRowRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const selectionBarRef = useRef<HTMLDivElement>(null);
  const tableBarRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const brush = useRef<InlineBrush | null>(null);
  const [rowWidth, setRowWidth] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  useActionMenu(moreMenuRef, moreOpen, () => setMoreOpen(false), undefined, {nativeControls:true,allowOutside:target=>!!target.closest('.note-editor-tools__more')});
  const [format, setFormat] = useState<FormatState>(EMPTY_FORMAT);
  const [selectionPosition, setSelectionPosition] = useState<CSSProperties | null>(null);
  const [tableBar, setTableBar] = useState<TableBarState | null>(null);
  const [tableBarSize, setTableBarSize] = useState({ width: 0, height: 0 });
  const [painting, setPainting] = useState(false);
  const locked = disabled || reading;
  const tableVisible = !!tableBar && !locked;
  const visibleTools = useMemo(() => allocateVisibleTools(rowWidth), [rowWidth]);
  const hiddenTools = useMemo(() => MAIN_TOOLS.filter(tool => !visibleTools.has(tool.key)), [visibleTools]);

  const saveCurrentRange = useCallback(() => {
    if (!engine) return;
    const range = selectionRange(engine.editor);
    if (range) savedRange.current = range.cloneRange();
  }, [engine]);

  const restoreSavedRange = useCallback((focus = true): boolean => {
    if (!engine) return false;
    const range = savedRange.current;
    if (!range || !engine.editor.contains(range.commonAncestorContainer)) return false;
    const selection = window.getSelection();
    if (!selection) return false;
    if (focus) engine.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }, [engine]);

  const syncState = useCallback(() => {
    if (!engine) {
      setFormat(EMPTY_FORMAT);
      setSelectionPosition(null);
      setTableBar(null);
      return;
    }
    const range = selectionRange(engine.editor);
    if (range) {
      savedRange.current = range.cloneRange();
      setFormat(getFormatState(engine.editor));
      if (!range.collapsed && !locked) {
        const rect = selectedRect(range);
        setSelectionPosition(rect ? pointStyle(rect, 164, 52) : null);
      } else setSelectionPosition(null);
    } else {
      setFormat(EMPTY_FORMAT);
      setSelectionPosition(null);
    }
    if (!locked) {
      const state = engine.getTableState();
      if (state.active && state.table) {
        const rect = state.table.getBoundingClientRect();
        setTableBar({ table: state.table, canMerge: state.canMerge, canSplit: state.canSplit, selectedCount: state.selectedCount, rect });
      } else setTableBar(null);
    } else setTableBar(null);
  }, [engine, locked]);

  useEffect(() => {
    if (reading) {
      setRowWidth(0);
      return;
    }
    const row = mainRowRef.current;
    if (!row) return;
    const measure = () => setRowWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [reading, engine]);

  useEffect(() => {
    if (!tableVisible) {
      setTableBarSize({ width: 0, height: 0 });
      return;
    }
    const bar = tableBarRef.current;
    if (!bar) return;
    const measure = () => {
      const rect = bar.getBoundingClientRect();
      setTableBarSize(current => current.width === rect.width && current.height === rect.height ? current : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [tableVisible]);

  useEffect(() => {
    if (!reading && !disabled) return;
    setMoreOpen(false);
    setSelectionPosition(null);
    setTableBar(null);
    brush.current = null;
    setPainting(false);
  }, [reading, disabled]);

  useEffect(() => {
    if (!engine || reading) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(syncState);
    };
    const applyBrushAfterSelection = () => {
      const activeBrush = brush.current;
      if (!activeBrush || !engine.editor.isConnected) return;
      requestAnimationFrame(() => {
        const range = selectionRange(engine.editor);
        if (!range || range.collapsed || equalRange(range, activeBrush.sourceRange)) return;
        const currentRange = range.cloneRange();
        const currentSelection = window.getSelection();
        if (!currentSelection) return;
        const applyCommand = (command: string) => {
          if (!activeBrush.commands.includes(command as InlineBrush['commands'][number])) return;
          restoreSavedRange();
          if (!isCommandOn(command)) engine.exec(command);
        };
        savedRange.current = currentRange;
        applyCommand('bold');
        applyCommand('italic');
        applyCommand('underline');
        applyCommand('strikeThrough');
        if (activeBrush.color) {
          restoreSavedRange();
          engine.exec('foreColor', activeBrush.color);
        }
        if (activeBrush.highlight) {
          restoreSavedRange();
          engine.exec('hiliteColor', activeBrush.highlight);
        }
        if (activeBrush.commands.includes('insertCodeInline')) {
          restoreSavedRange();
          engine.insertCodeInline();
        }
        brush.current = null;
        setPainting(false);
        syncState();
      });
    };
    const handleTableState = () => update();
    const handleSelectionFinish = () => applyBrushAfterSelection();
    const onScroll = () => update();
    document.addEventListener('selectionchange', update);
    engine.editor.addEventListener('penmark:table-state', handleTableState);
    engine.editor.addEventListener('mouseup', handleSelectionFinish);
    engine.editor.addEventListener('keyup', handleSelectionFinish);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    surface?.addEventListener('scroll', onScroll, true);
    update();
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('selectionchange', update);
      engine.editor.removeEventListener('penmark:table-state', handleTableState);
      engine.editor.removeEventListener('mouseup', handleSelectionFinish);
      engine.editor.removeEventListener('keyup', handleSelectionFinish);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
      surface?.removeEventListener('scroll', onScroll, true);
      brush.current = null;
    };
  }, [engine, surface, reading, restoreSavedRange, syncState]);

  useEffect(() => {
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inRoot = rootRef.current?.contains(target) === true;
      const inPopup = selectionBarRef.current?.contains(target) === true || tableBarRef.current?.contains(target) === true;
      if (!inRoot) setMoreOpen(false);
      if (!inRoot && !inPopup) setSelectionPosition(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (moreOpen || painting) {
        event.preventDefault();
        setMoreOpen(false);
        brush.current = null;
        setPainting(false);
      }
    };
    if (reading) return;
    document.addEventListener('pointerdown', closeOnOutside, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [moreOpen, painting, reading]);

  const invokeEditor = useCallback((action: (editor: Editor) => void) => {
    if (!engine || locked) return;
    restoreSavedRange();
    action(engine);
    syncState();
  }, [engine, locked, restoreSavedRange, syncState]);

  const chooseHeading = (event: ChangeEvent<HTMLSelectElement>) => {
    const tag = event.currentTarget.value;
    invokeEditor(editor => editor.formatBlock(tag));
    setMoreOpen(false);
  };

  const startFormatPainter = () => {
    if (!engine || locked) return;
    saveCurrentRange();
    restoreSavedRange();
    const nextBrush = readInlineBrush(engine.editor);
    if (!nextBrush) {
      setMoreOpen(false);
      return;
    }
    brush.current = nextBrush;
    setPainting(true);
    setMoreOpen(false);
  };

  const runTool = (key: ToolKey) => {
    if (key === 'heading') return;
    if (key === 'paint') {
      startFormatPainter();
      return;
    }
    if (key === 'image') {
      if (engine && !locked) {
        restoreSavedRange();
        engine.focus();
        onImage();
      }
    } else if (key === 'bold') invokeEditor(editor => editor.exec('bold'));
    else if (key === 'italic') invokeEditor(editor => editor.exec('italic'));
    else if (key === 'underline') invokeEditor(editor => editor.exec('underline'));
    else if (key === 'strike') invokeEditor(editor => editor.exec('strikeThrough'));
    else if (key === 'highlight') invokeEditor(editor => editor.exec('hiliteColor', format.highlight ? 'transparent' : '#f4df9b'));
    else if (key === 'unordered') invokeEditor(editor => editor.exec('insertUnorderedList'));
    else if (key === 'ordered') invokeEditor(editor => editor.exec('insertOrderedList'));
    else if (key === 'align-left') invokeEditor(editor => editor.exec('justifyLeft'));
    else if (key === 'align-center') invokeEditor(editor => editor.exec('justifyCenter'));
    else if (key === 'align-right') invokeEditor(editor => editor.exec('justifyRight'));
    else if (key === 'align-justify') invokeEditor(editor => editor.exec('justifyFull'));
    else if (key === 'todo') invokeEditor(editor => editor.insertTodo());
    else if (key === 'quote') invokeEditor(editor => editor.insertQuote());
    else if (key === 'inline-code') invokeEditor(editor => editor.insertCodeInline());
    else if (key === 'code-block') invokeEditor(editor => editor.insertCodeBlock());
    else if (key === 'table') invokeEditor(editor => editor.insertTable(3, 3));
    else if (key === 'rule') invokeEditor(editor => editor.insertHR());
    else if (key === 'clear') invokeEditor(editor => editor.exec('removeFormat'));
    else if (key === 'link') invokeEditor(editor => { void editor.insertLink(); });
    else if (key === 'undo') invokeEditor(editor => { editor.undo(); });
    else if (key === 'redo') invokeEditor(editor => { editor.redo(); });
    setMoreOpen(false);
  };

  const runTableCommand = (action: Parameters<Editor['tableCommand']>[0]) => {
    if (!engine || locked) return;
    restoreSavedRange();
    engine.tableCommand(action);
    syncState();
  };

  const renderHeadingSelect = (inMenu = false) => <label className={`note-editor-tools__heading${inMenu ? ' is-menu' : ''}`}>
    {inMenu ? <span>段落样式</span> : <Heading size={15} aria-hidden="true"/>}
    <select aria-label="段落样式" value={format.block} disabled={locked || !engine} onMouseDown={saveCurrentRange} onChange={chooseHeading}>
      <option value="p">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option><option value="h4">标题 4</option>
    </select>
    {!inMenu && <ChevronDown size={12} aria-hidden="true"/>}
  </label>;

  const pressed = (key: ToolKey): boolean => {
    if (key === 'bold') return format.bold;
    if (key === 'italic') return format.italic;
    if (key === 'underline') return format.underline;
    if (key === 'strike') return format.strike;
    if (key === 'highlight') return format.highlight;
    if (key === 'unordered') return format.unordered;
    if (key === 'ordered') return format.ordered;
    if (key === 'quote') return format.quote;
    if (key === 'inline-code') return format.inlineCode;
    if (key === 'code-block') return format.codeBlock;
    if (key === 'align-left') return format.align === 'left';
    if (key === 'align-center') return format.align === 'center';
    if (key === 'align-right') return format.align === 'right';
    if (key === 'align-justify') return format.align === 'justify';
    if (key === 'paint') return painting;
    return false;
  };

  const renderButton = (tool: ToolDefinition, inMenu = false) => {
    const Icon = tool.icon;
    const isPressed = pressed(tool.key);
    return <button
      key={tool.key}
      className={`note-editor-tools__button${inMenu ? ' is-menu' : ''}${isPressed ? ' is-active' : ''}`}
      type="button"
      title={tool.label}
      aria-label={tool.label}
      aria-pressed={isPressed}
      disabled={locked || !engine || (tool.key === 'paint' && !selectionRange(engine?.editor as HTMLElement))}
      onMouseDown={saveCurrentRange}
      onClick={() => runTool(tool.key)}
    >
      <Icon size={15} strokeWidth={1.8} aria-hidden="true"/>
      {inMenu && <span>{tool.label}</span>}
    </button>;
  };

  const menuTools = [...hiddenTools.filter(tool => tool.key !== 'heading'), ...MORE_TOOLS];
  const tableStyle = tableBar ? pointStyle(tableBar.rect, Math.min(tableBarSize.width || 448, window.innerWidth - 16), tableBarSize.height || 52, true) : undefined;
  const activeRange = engine ? selectionRange(engine.editor) : null;
  const hasTextSelection = !!activeRange && !activeRange.collapsed;
  const rootBounds = rootRef.current?.getBoundingClientRect();
  const menuWidth = Math.min(296, window.innerWidth - 24);
  const menuPosition: CSSProperties = {position:'fixed',right:'auto',width:menuWidth,left:Math.max(12,Math.min((rootBounds?.right??menuWidth+12)-menuWidth,window.innerWidth-menuWidth-12)),top:Math.max(8,Math.min((rootBounds?.bottom??0)+6,window.innerHeight-Math.min(360,window.innerHeight*.6)-8))};

  if (reading) return null;

  return <div
    className={`note-editor-tools pm-editor-toolbar${painting ? ' is-painting' : ''}`}
    ref={rootRef}
    data-disabled={locked ? 'true' : undefined}
    onMouseDownCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
      saveCurrentRange();
      if ((event.target as HTMLElement).closest('button')) event.preventDefault();
    }}
  >
    <div className="note-editor-tools__row" ref={mainRowRef} role="toolbar" aria-label="文字格式">
      {MAIN_TOOLS.filter(tool => visibleTools.has(tool.key)).map(tool => tool.key === 'heading' ? <span className="note-editor-tools__heading-wrap" key={tool.key}>{renderHeadingSelect()}</span> : renderButton(tool))}
      {(hiddenTools.length > 0 || MORE_TOOLS.length > 0) && <button className={`note-editor-tools__button note-editor-tools__more${moreOpen ? ' is-active' : ''}`} type="button" title="更多格式" aria-label="更多格式" aria-haspopup="menu" aria-expanded={moreOpen} disabled={locked || !engine} onClick={() => setMoreOpen(open => !open)}><MoreHorizontal size={17} aria-hidden="true"/></button>}
    </div>
    {moreOpen && <div className="note-editor-tools__menu" style={menuPosition} ref={moreMenuRef} role="menu" aria-label="更多格式">
      {hiddenTools.some(tool => tool.key === 'heading') && renderHeadingSelect(true)}
      {menuTools.map(tool => renderButton(tool, true))}
      <label className="note-editor-tools__setting">
        <span>字体</span>
        <select aria-label="选中文字字体" defaultValue="inherit" disabled={locked || !engine || !hasTextSelection} onMouseDown={saveCurrentRange} onChange={event => invokeEditor(editor => editor.exec('fontName', event.currentTarget.value))}>
          <option value="inherit">设备字体</option><option value="Georgia, serif">衬线</option><option value="monospace">等宽</option>
        </select>
      </label>
      <label className="note-editor-tools__setting">
        <span>字号</span>
        <select aria-label="选中文字字号" defaultValue="3" disabled={locked || !engine || !hasTextSelection} onMouseDown={saveCurrentRange} onChange={event => {
          const value = event.currentTarget.value;
          invokeEditor(editor => editor.exec('fontSize', value));
        }}>
          <option value="2">小</option><option value="3">默认</option><option value="4">大</option><option value="5">特大</option>
        </select>
      </label>
      <label className="note-editor-tools__setting note-editor-tools__color-setting">
        <span>文字色</span>
        <input aria-label="选中文字颜色" type="color" defaultValue="#435461" disabled={locked || !engine || !hasTextSelection} onMouseDown={saveCurrentRange} onChange={event => {
          const color = event.currentTarget.value;
          invokeEditor(editor => editor.exec('foreColor', color));
        }}/>
      </label>
    </div>}
    {painting && <span className="note-editor-tools__paint-status" role="status">格式刷已就绪，选择要应用格式的文字</span>}
    {selectionPosition && engine && !locked && <div className="note-editor-tools__selection" ref={selectionBarRef} style={selectionPosition} role="toolbar" aria-label="选中文字格式">
      {renderButton(MAIN_TOOLS.find(tool => tool.key === 'bold')!)}
      {renderButton(MAIN_TOOLS.find(tool => tool.key === 'italic')!)}
      {renderButton(ALL_TOOLS.find(tool => tool.key === 'highlight')!)}
      <button className={`note-editor-tools__button${format.link ? ' is-active' : ''}`} type="button" title="插入链接" aria-label="插入链接" aria-pressed={format.link} disabled={locked} onMouseDown={saveCurrentRange} onClick={() => invokeEditor(editor => { void editor.insertLink(); })}><Link2 size={15} aria-hidden="true"/></button>
    </div>}
    {tableBar && !locked && tableStyle && <div className="note-editor-tools__table" ref={tableBarRef} style={tableStyle} role="toolbar" aria-label="表格工具">
      <button className="note-editor-tools__button" type="button" title="上方插入行" aria-label="上方插入行" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('row-before')}><PanelTopOpen size={16} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="下方插入行" aria-label="下方插入行" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('row-after')}><PanelBottomOpen size={16} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="删除当前行" aria-label="删除当前行" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('delete-row')}><Rows3 size={16} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="左侧插入列" aria-label="左侧插入列" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('col-left')}><PanelLeftOpen size={16} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="右侧插入列" aria-label="右侧插入列" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('col-right')}><PanelRightOpen size={16} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="删除当前列" aria-label="删除当前列" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('delete-col')}><Columns3 size={16} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="合并单元格" aria-label="合并单元格" disabled={!tableBar.canMerge} onMouseDown={saveCurrentRange} onClick={() => runTableCommand('merge')}><Link2 size={14} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="拆分单元格" aria-label="拆分单元格" disabled={!tableBar.canSplit} onMouseDown={saveCurrentRange} onClick={() => runTableCommand('split')}><Unlink2 size={14} aria-hidden="true"/></button>
      <button className={`note-editor-tools__button${format.align === 'left' ? ' is-active' : ''}`} type="button" title="单元格文字左对齐" aria-label="单元格文字左对齐" aria-pressed={format.align === 'left'} onMouseDown={saveCurrentRange} onClick={() => invokeEditor(editor => editor.exec('justifyLeft'))}><AlignLeft size={14} aria-hidden="true"/></button>
      <button className={`note-editor-tools__button${format.align === 'center' ? ' is-active' : ''}`} type="button" title="单元格文字居中" aria-label="单元格文字居中" aria-pressed={format.align === 'center'} onMouseDown={saveCurrentRange} onClick={() => invokeEditor(editor => editor.exec('justifyCenter'))}><AlignCenter size={14} aria-hidden="true"/></button>
      <button className={`note-editor-tools__button${format.align === 'right' ? ' is-active' : ''}`} type="button" title="单元格文字右对齐" aria-label="单元格文字右对齐" aria-pressed={format.align === 'right'} onMouseDown={saveCurrentRange} onClick={() => invokeEditor(editor => editor.exec('justifyRight'))}><AlignRight size={14} aria-hidden="true"/></button>
      <button className="note-editor-tools__button" type="button" title="列宽均分" aria-label="列宽均分" onMouseDown={saveCurrentRange} onClick={() => runTableCommand('equalize')}><Table2 size={14} aria-hidden="true"/></button>
    </div>}
  </div>;
}

// Adapted from the owner’s PenMark (MIT). See LICENSE-PenMark.txt.
// 知著 PenMark Markdown → HTML 转换（纯函数模块，无 DOM 依赖，node 可测）
// 从 editor.js 抽出，供编辑器粘贴、设置页批量导入、桌面导入复用。
// 支持脚注语法：正文 [^id] → <sup class="fn-ref">，定义 [^id]: 文本 收拢到文末脚注区。

export function escapeHtmlInline(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 脚注定义行：[^id]: 内容（与 GFM 兼容，id 允许字母数字下划线连字符）
const FOOTNOTE_DEF_RE = /^\s{0,3}\[\^([A-Za-z0-9_-]+)\]:\s*(.*)$/;

// 文章级上下文：跨行收集脚注引用与定义，输出阶段统一处理
function createFootnoteState() {
  return {
    defs: new Map(),    // id → 定义文本（已行内转换）
    usedIds: new Set(), // 正文实际引用过的 id
    idIndex: new Map(), // id → 分配的展示序号
    nextIndex: 1
  };
}

function fnRefHtml(state, id) {
  let index = state.idIndex.get(id);
  if (index === undefined) {
    index = state.nextIndex++;
    state.idIndex.set(id, index);
  }
  const first = !state.usedIds.has(id); // 同一脚注多次引用时，id 只给首次引用，避免重复 id
  state.usedIds.add(id);
  return '<sup class="fn-ref" data-fn-id="' + id + '">' +
    '<a href="#fn-' + id + '"' + (first ? ' id="fnref-' + id + '"' : '') + '>' + index + '</a></sup>';
}

// 渲染文末脚注区；无任何被引用的定义时返回空字符串（不出空区块）
function fnSectionHtml(state) {
  const items = [];
  for (const [id, text] of state.defs) {
    if (!state.usedIds.has(id)) continue;
    items.push('<li class="footnote-item" id="fn-' + id + '" data-fn-id="' + id + '">' +
      '<span class="footnote-text">' + text + '</span>' +
      '<a class="fn-back" href="#fnref-' + id + '" data-fn-back="1" aria-label="返回引用处"></a></li>');
  }
  if (!items.length) return '';
  return '<hr class="footnote-sep"><section class="footnotes"><div class="footnote-title">注释</div>' +
    '<ol class="footnote-list">' + items.join('') + '</ol></section>';
}

export function markdownToHtml(text) {
  const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  const fn = createFootnoteState();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```...```
    if (/^\s{0,3}```/.test(line)) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s{0,3}```/.test(lines[i])) {
        codeLines.push(escapeHtmlInline(lines[i]));
        i++;
      }
      i++; // 跳过闭合 ```
      out.push('<pre><code>' + codeLines.join('\n') + '</code></pre>');
      continue;
    }

    // 脚注定义行：收集后跳过，不出现在正文流
    const fdm = line.match(FOOTNOTE_DEF_RE);
    if (fdm) {
      fn.defs.set(fdm[1], mdInline(fdm[2]));
      i++;
      continue;
    }

    // 标题 # ~ ######
    const hm = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (hm) {
      const lv = hm[1].length;
      out.push('<h' + lv + '>' + mdInline(hm[2], fn) + '</h' + lv + '>');
      i++;
      continue;
    }

    // 分割线 --- / *** / ___
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 表格：表头行 + 分隔行（GFM 表格）
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      i += 2; // 跳过表头行与分隔行
      const bodyRows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const n = Math.max(headerCells.length, 1);
      const colgroup = '<colgroup>' +
        Array.from({ length: n }, () => '<col style="width:' + (100 / n).toFixed(3) + '%">').join('') +
        '</colgroup>';
      let html = '<table data-pm-table="1">' + colgroup + '<thead><tr>';
      for (let c = 0; c < n; c++) html += '<th>' + mdInline(headerCells[c] || '', fn) + '</th>';
      html += '</tr></thead><tbody>';
      for (const row of bodyRows) {
        html += '<tr>';
        for (let c = 0; c < n; c++) html += '<td>' + mdInline(row[c] || '', fn) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    // 引用块 >（连续 > 行合并）
    if (/^\s{0,3}>\s?/.test(line)) {
      const ql = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        ql.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + mdInline(ql.join('<br>'), fn) + '</blockquote>');
      continue;
    }

    // 无序列表 - / * / +
    if (/^\s{0,3}[-*+]\s+\S/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s{0,3}[-*+]\s+\S/.test(lines[i])) {
        items.push('<li>' + mdInline(lines[i].replace(/^\s{0,3}[-*+]\s+/, ''), fn) + '</li>');
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    // 有序列表 1.
    if (/^\s{0,3}\d+\.\s+\S/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s{0,3}\d+\.\s+\S/.test(lines[i])) {
        items.push('<li>' + mdInline(lines[i].replace(/^\s{0,3}\d+\.\s+/, ''), fn) + '</li>');
        i++;
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    // 空行：跳过（段落由空行分隔）
    if (/^\s*$/.test(line)) { i++; continue; }

    // 普通段落：连续非空、非块级行合并
    const pl = [];
    while (i < lines.length
      && !/^\s*$/.test(lines[i])
      && !/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|```|(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i])) {
      pl.push(lines[i]);
      i++;
    }
    if (pl.length) out.push('<p>' + mdInline(pl.join('<br>'), fn) + '</p>');
  }
  return out.join('') + fnSectionHtml(fn);
}

// GFM 表格辅助：识别表头行 / 分隔行 / 拆分单元格
function isTableRow(line) {
  return /^\s*\|/.test(line); // 以 | 开头（允许前导空白）
}
function isTableSeparator(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return /-/.test(t) && /^[\s:|-]+$/.test(t); // 只含空格、|、:、- 且含 -
}
function splitTableRow(line) {
  let s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

// Markdown 行内语法：先转义 HTML，再依次处理行内代码（保护）、脚注引用、链接、粗体、斜体
export function mdInline(text, fnState) {
  let s = escapeHtmlInline(text);
  // 行内代码先抽出占位，避免被后续正则误伤
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0000C' + (codes.length - 1) + '\u0000';
  });
  // 脚注引用 [^id] → 上标（在链接之前处理，避免被链接正则误伤）
  if (fnState) {
    s = s.replace(/\[\^([A-Za-z0-9_-]+)\]/g, (m, id) => fnRefHtml(fnState, id));
  }
  // 链接 [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|www\.[^\s)]+)\)/g, (m, t, u) => {
    const href = u.startsWith('www.') ? 'http://' + u : u;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + t + '</a>';
  });
  // 粗体 **xxx**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 斜体 *xxx*（粗体已处理，剩余单 * 即斜体；不匹配跨行）
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // 注：不处理 _xxx_ 斜体，避免误伤 file_name、snake_case 等下划线文本
  // 还原行内代码
  s = s.replace(/\u0000C(\d+)\u0000/g, (m, idx) => '<code>' + codes[Number(idx)] + '</code>');
  return s;
}

import { useEffect, type RefObject } from 'react';
import './note-code-reader.css';

/** Read-only decorations never participate in editor history or persistence. */
export function useNoteCodeReader(surface: RefObject<HTMLElement | null>, reading: boolean) {
  useEffect(() => {
    const root = surface.current;
    if (!reading || !root) return;
    let active = true;
    const entries: {pre: HTMLElement; wrapper: HTMLElement; code: HTMLElement | null; original: string | null; className: string | null}[] = [];
    for (const pre of root.querySelectorAll<HTMLElement>('pre')) {
      const code = pre.querySelector<HTMLElement>('code');
      const wrapper = document.createElement('div'); wrapper.className = 'code-block';
      const bar = document.createElement('div'); bar.className = 'cb-bar'; bar.contentEditable = 'false';
      const collapse = document.createElement('button'); collapse.type = 'button'; collapse.textContent = '折叠'; collapse.setAttribute('aria-label','折叠代码块');
      collapse.onclick = () => { const collapsed = wrapper.classList.toggle('collapsed'); collapse.textContent = collapsed ? '展开' : '折叠'; collapse.setAttribute('aria-label', collapsed ? '展开代码块' : '折叠代码块'); };
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '复制代码'; copy.setAttribute('aria-label','复制代码');
      copy.onclick = async () => { try { await navigator.clipboard.writeText(pre.textContent ?? ''); if(active)copy.textContent='已复制'; } catch { if(active)copy.textContent='复制失败，请选择代码复制'; } };
      bar.append(collapse,copy); pre.before(wrapper); wrapper.append(bar,pre);
      entries.push({pre,wrapper,code,original:code?.innerHTML ?? null,className:code?.getAttribute('class')??null});
    }
    if (entries.some(entry => entry.code)) void import('./penmark/highlight-runtime.js').then(({default:hljs}) => {
      if(!active)return;
      for (const entry of entries) if(entry.code) { try { hljs.highlightElement(entry.code); } catch { /* Unknown languages remain readable. */ } }
    }).catch(() => { /* The original code remains readable if the optional chunk fails. */ });
    return () => { active=false; for(const entry of entries) { if(entry.code&&entry.original!==null) { entry.code.innerHTML=entry.original;entry.code.removeAttribute('data-highlighted');if(entry.className===null)entry.code.removeAttribute('class');else entry.code.setAttribute('class',entry.className); } if(entry.wrapper.isConnected)entry.wrapper.replaceWith(entry.pre); } };
  }, [surface,reading]);
}

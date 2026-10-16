/** Untrusted PenMark HTML is retained in storage; every render crosses this allowlist. */
const TAGS = new Set('p div span br hr h1 h2 h3 h4 h5 h6 strong b em i u s strike del mark sub sup blockquote pre code ul ol li table thead tbody tfoot tr th td colgroup col a img figure figcaption section kbd'.split(' '));
const DROP = 'script,style,iframe,object,embed,form,input,button,textarea,select,option,svg,math,link,meta,base,template,noscript';
const STYLE = new Set('color background-color font-size font-weight font-style font-family text-decoration text-align line-height width height max-width min-width border border-collapse border-color border-width border-style border-radius padding padding-left padding-right padding-top padding-bottom margin margin-left margin-right margin-top margin-bottom vertical-align white-space'.split(' '));
export function safeNoteUrl(value: string, image = false): boolean {
    const url = value.trim();
    if (image && /^data:image\/(?:png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i.test(url))
        return true;
    if (/^[\u0000-\u0020]*[a-z][a-z\d+.-]*:/i.test(url))
        return image ? /^https?:\/\//i.test(url) : /^(https?:\/\/|mailto:|tel:)/i.test(url);
    return !url.startsWith('//') && !/[\u0000-\u001f\\]/.test(url) && !/%(?:00|0a|0d)/i.test(url);
}
export function sanitizeNoteHtml(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(DROP).forEach(node => node.remove());
    doc.querySelectorAll('.rs-handle,.img-size-label,.pm-table-resize-layer').forEach(node => node.remove());
    doc.querySelectorAll('.img-container').forEach(node => {
        if (!node.querySelector('img'))
            node.remove();
    });
    for (const el of Array.from(doc.body.querySelectorAll('*'))) {
        if (!TAGS.has(el.tagName.toLowerCase())) {
            el.replaceWith(...Array.from(el.childNodes));
            continue;
        }
        for (const attribute of Array.from(el.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name === 'style') {
                const style = (el as HTMLElement).style;
                for (const key of Array.from(style))
                    if (!STYLE.has(key) || /url\s*\(|expression|var\s*\(|@|\\/i.test(style.getPropertyValue(key)))
                        style.removeProperty(key);
            }
            else if (name === 'href' && el.tagName === 'A') {
                if (!safeNoteUrl(attribute.value))
                    el.removeAttribute(name);
            }
            else if (name === 'src' && el.tagName === 'IMG') {
                if (!safeNoteUrl(attribute.value, true))
                    el.removeAttribute(name);
            }
            else if (name === 'class') {
                el.setAttribute('class', attribute.value.split(/\s+/).filter(value => /^(?:img-|todo-|pm-|fn-|footnote|link-card|code-)/.test(value)).join(' '));
            }
            else if (!['alt', 'title', 'width', 'height', 'colspan', 'rowspan', 'align', 'start', 'data-align', 'data-fn-id', 'data-fn-back', 'data-count', 'data-checked'].includes(name) && !(name === 'id' && /^(?:fn-|fnref-|pm)/.test(attribute.value)))
                el.removeAttribute(name);
        }
        if (el.tagName === 'A') {
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
        }
        if (el.tagName === 'IMG') {
            el.setAttribute('referrerpolicy', 'no-referrer');
            el.setAttribute('decoding', 'async');
        }
    }
    return doc.body.innerHTML;
}
export function textToNoteHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.split('\n').map(line => `<p>${line || '<br>'}</p>`).join('');
}
export function noteHtmlText(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('p,div,h1,h2,h3,h4,h5,h6,li,tr,blockquote,pre,br').forEach(el => el.append('\n'));
    return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

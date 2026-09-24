import type { PineDocView } from '../pine/pine-docs';
import type { SignatureHelpInfo } from '../pine/pine-signature';

/**
 * DOM for the editor's tooltips. Doc strings come from the catalog and from the operator's own
 * comments, so everything is set as text — never as HTML. Backtick spans become `<code>`.
 */

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Text with `code` spans, as DOM. */
export function richText(parent: HTMLElement, text: string): void {
  const parts = text.split('`');
  parts.forEach((part, i) => {
    if (!part) return;
    parent.appendChild(i % 2 === 1 ? el('code', undefined, part) : document.createTextNode(part));
  });
}

export function renderDocView(view: PineDocView, className = 'cm-pine-hover'): HTMLElement {
  const root = el('div', className);
  root.appendChild(el('div', 'cm-pine-kind', view.kind));
  for (const line of view.code) root.appendChild(el('div', 'cm-pine-code', line));
  if (view.doc) {
    const doc = el('div', 'cm-pine-doc');
    richText(doc, view.doc);
    root.appendChild(doc);
  }
  for (const note of view.notes) {
    const n = el('div', 'cm-pine-doc');
    richText(n, note);
    root.appendChild(n);
  }
  return root;
}

export function renderSignatureHelp(info: SignatureHelpInfo): HTMLElement {
  const root = el('div', 'cm-pine-sig');
  if (info.overloads.length > 1) {
    root.appendChild(
      el('div', 'cm-pine-sig-count', `${info.overloads.length} overloads`),
    );
  }
  info.overloads.forEach((o, i) => {
    const active = i === info.activeOverload;
    const line = el('div', `cm-pine-sig-overload${active ? ' is-active' : ''}`);
    line.appendChild(document.createTextNode(`${o.label}(`));
    o.params.forEach((p, j) => {
      if (j > 0) line.appendChild(document.createTextNode(', '));
      if (active && j === info.activeParam) line.appendChild(el('span', 'cm-pine-sig-param', p.name));
      else line.appendChild(document.createTextNode(p.name));
    });
    if (o.variadic) line.appendChild(document.createTextNode(', …'));
    line.appendChild(document.createTextNode(`)${o.returns ? ` → ${o.returns}` : ''}`));
    root.appendChild(line);
  });
  const active = info.overloads[info.activeOverload];
  const param = active && info.activeParam >= 0 ? active.params[info.activeParam] : null;
  if (param) {
    const doc = el('div', 'cm-pine-doc');
    const head = [param.name, param.type ? `(${param.type})` : '', param.optional ? 'optional' : '']
      .filter(Boolean)
      .join(' ');
    doc.appendChild(el('code', undefined, head));
    if (param.defaultText) doc.appendChild(document.createTextNode(` = ${param.defaultText}`));
    if (param.doc) {
      doc.appendChild(document.createTextNode(' — '));
      richText(doc, param.doc);
    }
    root.appendChild(doc);
  } else if (info.doc) {
    const doc = el('div', 'cm-pine-doc');
    richText(doc, info.doc.length > 280 ? `${info.doc.slice(0, 277)}…` : info.doc);
    root.appendChild(doc);
  }
  return root;
}

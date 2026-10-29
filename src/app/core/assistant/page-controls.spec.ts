import { describe, expect, it } from 'vitest';
import {
  clickRefusal,
  controlLabel,
  fieldRefusal,
  findClickTarget,
  findField,
  findWithin,
  isWriteLikeLabel,
  listControls,
  pressEnter,
  setFieldValue,
} from './page-controls';

/** jsdom has no layout: like page-reader.spec, everything not explicitly hidden counts as visible. */
function page(html: string, overlay = ''): HTMLElement {
  document.body.innerHTML = `<main><div class="page">${html}</div></main>${overlay}
    <app-assistant-dock><input aria-label="Ask the assistant" /><button>Send</button></app-assistant-dock>`;
  return document.querySelector('main .page') as HTMLElement;
}

const LIST_PAGE = `
  <h1>Positions</h1>
  <div class="filters">
    <label class="field"><span class="label">Symbol</span><input type="text" value="" /></label>
    <label for="st">Status</label>
    <select id="st"><option value="">All</option><option value="Open">Open positions</option><option value="Closed">Closed</option></select>
    <label><input type="checkbox" /> Show demo accounts</label>
    <input type="date" aria-label="From" />
    <input type="search" placeholder="Search…" aria-label="Search within table" />
    <input type="password" aria-label="Broker password" />
    <fieldset role="radiogroup" aria-label="Side">
      <label><input type="radio" name="side" value="all" checked /> All</label>
      <label><input type="radio" name="side" value="buy" /> Long</label>
    </fieldset>
  </div>
  <details><summary>Advanced filters</summary><p>…</p></details>
  <button type="button" aria-expanded="false">More options</button>
  <button type="button">Pause strategy</button>
  <button type="button" aria-label="Delete">🗑</button>
  <button type="button">Show more</button>
  <table>
    <thead><tr><th aria-sort="none">Symbol</th><th>Lots</th><th></th></tr></thead>
    <tbody>
      <tr class="clickable"><td>EURUSD</td><td>0.10</td><td><button type="button">Details</button><button type="button">Close</button></td></tr>
      <tr class="clickable"><td>GBPUSD</td><td>0.20</td><td><button type="button">Details</button><button type="button">Close</button></td></tr>
    </tbody>
  </table>
  <nav class="pagination"><button type="button" aria-label="Previous page">‹</button><button type="button" aria-label="Next page">›</button></nav>
  <a href="/positions/17">Position 17</a>
  <a href="https://broker.example.com/statement">Broker statement</a>
  <form><input type="text" aria-label="New alert name" /><button>Create alert</button><button type="submit">Go</button></form>
`;

describe('listControls', () => {
  it('lists fields with kind, value and options — never the dock, never a secret value', () => {
    page(LIST_PAGE);
    const r = listControls(document);
    const byLabel = Object.fromEntries(r.fields.map((f) => [f.label, f]));
    expect(byLabel['Symbol']).toMatchObject({ kind: 'text', value: '' });
    expect(byLabel['Status']).toMatchObject({
      kind: 'select',
      value: 'All',
      options: ['All', 'Open positions', 'Closed'],
    });
    expect(byLabel['Show demo accounts']).toMatchObject({ kind: 'checkbox', value: false });
    expect(byLabel['From']).toMatchObject({ kind: 'date' });
    expect(byLabel['Search within table']).toMatchObject({ kind: 'search' });
    expect(byLabel['Side']).toMatchObject({
      kind: 'radio',
      value: 'All',
      options: ['All', 'Long'],
    });
    // Password inputs are not fields at all; the dock's own input is not the page's.
    expect(r.fields.map((f) => f.label)).not.toContain('Broker password');
    expect(r.fields.map((f) => f.label)).not.toContain('Ask the assistant');
  });

  it('lists view controls and keeps actions out', () => {
    page(LIST_PAGE);
    const r = listControls(document);
    const kinds = Object.fromEntries(r.controls.map((c) => [c.label, c]));
    expect(kinds['Advanced filters']).toMatchObject({ kind: 'expander', state: 'collapsed' });
    expect(kinds['More options']).toMatchObject({ kind: 'expander', state: 'collapsed' });
    expect(kinds['Show more']).toMatchObject({ kind: 'more' });
    expect(kinds['Symbol']).toMatchObject({ kind: 'sort', state: 'none' });
    expect(kinds['Next page']).toMatchObject({ kind: 'pagination' });
    expect(kinds['Details']).toMatchObject({ kind: 'button', repeats: 2 });
    expect(kinds['Position 17']).toMatchObject({ kind: 'link', href: '/positions/17' });
    for (const action of [
      'Pause strategy',
      'Delete',
      'Close',
      'Broker statement',
      'Create alert',
      'Go',
    ]) {
      expect(kinds[action]).toBeUndefined();
    }
    expect(r.actionsNotClickable).toEqual(
      expect.arrayContaining(['Pause strategy', 'Delete', 'Close', 'Create alert', 'Go']),
    );
    expect(r.controls.map((c) => c.label)).not.toContain('Send');
    expect(r.rows[0]).toMatchObject({ rows: 2, opensDetail: true, sample: ['EURUSD', 'GBPUSD'] });
  });

  it('reports overlays first, with where they are', () => {
    page(
      LIST_PAGE,
      `<div role="dialog" aria-label="Filter positions"><label>Account <input type="text" /></label><button type="button">Show all</button></div>`,
    );
    const r = listControls(document);
    expect(r.fields[0]).toMatchObject({ label: 'Account', where: 'dialog: Filter positions' });
    expect(r.controls[0]).toMatchObject({ label: 'Show all', where: 'dialog: Filter positions' });
  });
});

describe('setFieldValue', () => {
  it('types into a text field so Angular sees input + change', () => {
    page(LIST_PAGE);
    const el = findField(document, 'symbol')!;
    const seen: string[] = [];
    el.addEventListener('input', () => seen.push('input:' + (el as HTMLInputElement).value));
    el.addEventListener('change', () => seen.push('change'));
    expect(setFieldValue(el, 'EURUSD')).toEqual({ ok: true, value: 'EURUSD' });
    expect(seen).toEqual(['input:EURUSD', 'change']);
  });

  it('picks a select option by its text, or its value, and refuses unknown ones', () => {
    page(LIST_PAGE);
    const sel = findField(document, 'Status') as HTMLSelectElement;
    let changed = 0;
    sel.addEventListener('change', () => changed++);
    expect(setFieldValue(sel, 'open positions')).toEqual({ ok: true, value: 'Open positions' });
    expect(sel.value).toBe('Open');
    expect(setFieldValue(sel, 'Closed').value).toBe('Closed');
    expect(changed).toBe(2);
    const bad = setFieldValue(sel, 'Pending');
    expect(bad.ok).toBe(false);
    expect(bad.problem).toContain('Open positions');
  });

  it('ticks a checkbox by true/false with a real click', () => {
    page(LIST_PAGE);
    const box = findField(document, 'Show demo accounts') as HTMLInputElement;
    let clicks = 0;
    box.addEventListener('click', () => clicks++);
    expect(setFieldValue(box, 'true')).toEqual({ ok: true, value: true });
    expect(setFieldValue(box, true)).toEqual({ ok: true, value: true }); // already on: no click
    expect(clicks).toBe(1);
    expect(setFieldValue(box, false).value).toBe(false);
  });

  it('chooses a radio by its option label', () => {
    page(LIST_PAGE);
    const radio = findField(document, 'Side') ?? findField(document, 'All');
    expect(setFieldValue(radio!, 'Long')).toEqual({ ok: true, value: 'Long' });
  });

  it('presses Enter for a search box', () => {
    page(LIST_PAGE);
    const box = findField(document, 'Search within table')!;
    const keys: string[] = [];
    box.addEventListener('keydown', (e) =>
      keys.push(`${(e as KeyboardEvent).key}/${(e as KeyboardEvent).keyCode}`),
    );
    setFieldValue(box, 'eur');
    pressEnter(box);
    expect(keys).toEqual(['Enter/13']);
  });

  it('refuses secrets and disabled fields', () => {
    page(
      `<label>API key <input type="text" name="apiKey" /></label><input aria-label="Locked" disabled />`,
    );
    expect(fieldRefusal(findField(document, 'API key')!)).toContain('secret');
    expect(fieldRefusal(findField(document, 'Locked')!)).toContain('disabled');
  });
});

describe('click refusals', () => {
  it('refuses action labels unless it is a real tab', () => {
    page(
      `<button>Pause strategy</button><button aria-label="Delete">🗑</button><div role="tab">Run history</div><button>Buy</button>`,
    );
    const [pause, del, tab, buy] = [
      ...document.querySelectorAll('button, [role="tab"]'),
    ] as HTMLElement[];
    expect(clickRefusal(pause, controlLabel(pause))).toContain('changes data');
    expect(clickRefusal(del, controlLabel(del))).toContain('changes data');
    expect(clickRefusal(buy, controlLabel(buy))).toContain('changes data');
    expect(clickRefusal(tab, controlLabel(tab))).toBeNull();
  });

  it('refuses a form submit button, even an innocently named one', () => {
    page(
      `<form><input aria-label="q" /><button>Go</button><button type="button">Toggle hints</button></form>`,
    );
    const [go] = [...document.querySelectorAll('button')] as HTMLElement[];
    expect(clickRefusal(go, 'Go')).toContain('submits a form');
  });

  it('refuses links that leave the console', () => {
    page(
      `<a href="https://evil.example.com/x">Docs</a><a href="mailto:a@b.c">Mail</a><a href="/login">Sign-in page</a><a href="/strategies/4">Strategy 4</a><a href="/export.csv" download>Rows</a>`,
    );
    const [ext, mail, login, ok, dl] = [...document.querySelectorAll('a')] as HTMLElement[];
    expect(clickRefusal(ext, 'Docs')).toContain('leaves the console');
    expect(clickRefusal(mail, 'Mail')).toContain('not a page link');
    expect(clickRefusal(login, 'Sign-in page')).toContain('out of the console');
    expect(clickRefusal(dl, 'Rows')).toContain('downloads');
    expect(clickRefusal(ok, 'Strategy 4')).toBeNull();
  });

  it('never clicks inside the assistant panel', () => {
    page('');
    const send = document.querySelector('app-assistant-dock button') as HTMLElement;
    expect(clickRefusal(send, 'Send')).toContain('assistant panel');
  });

  it('knows action words beyond the crawler list', () => {
    for (const l of ['Buy', 'Sell', 'Create alert', 'Promote', 'Edit', 'Acknowledge'])
      expect(isWriteLikeLabel(l)).toBe(true);
    for (const l of ['Show more', 'Next page', 'Details', 'Symbol', 'Refresh'])
      expect(isWriteLikeLabel(l)).toBe(false);
  });
});

describe('within', () => {
  it('finds the row whose cell matches, and the control inside it', () => {
    page(LIST_PAGE);
    const row = findWithin(document, 'gbpusd')!;
    expect(row.tagName).toBe('TR');
    expect(row.textContent).toContain('GBPUSD');
    const t = findClickTarget(document, 'Details', row)!;
    expect(t.el.closest('tr')).toBe(row);
    expect(t.kind).toBe('button');
  });

  it('with only within, opens the row by its first plain cell', () => {
    page(LIST_PAGE);
    const row = findWithin(document, 'EURUSD')!;
    const t = findClickTarget(document, null, row)!;
    expect(t).toMatchObject({ kind: 'row', label: 'EURUSD' });
    expect(t.el.tagName).toBe('TD');
    let opened = 0;
    row.addEventListener('click', () => opened++);
    t.el.click();
    expect(opened).toBe(1);
  });

  it('a label that is a cell value opens its row', () => {
    page(LIST_PAGE);
    const t = findClickTarget(document, 'GBPUSD', null)!;
    expect(t.kind).toBe('row');
    expect(t.el.closest('tr')!.textContent).toContain('GBPUSD');
  });

  it('falls back to the smallest section containing the text', () => {
    page(
      `<section class="card"><h3>Risk</h3><label>Max lots <input /></label></section><section class="card"><h3>Alerts</h3><label>Max lots <input /></label></section>`,
    );
    const sec = findWithin(document, 'Alerts')!;
    const field = findField(document, 'Max lots', sec)!;
    expect(sec.contains(field)).toBe(true);
    expect(sec.textContent).toContain('Alerts');
  });

  it('returns null when nothing contains the text', () => {
    page(LIST_PAGE);
    expect(findWithin(document, 'XAUUSD')).toBeNull();
  });
});

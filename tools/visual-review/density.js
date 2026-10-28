// How full a page looks. Runs inside the page (page.evaluate(density)) and returns plain numbers,
// so crawl.js can flag pages that render as a header and a few "No … yet" boxes.
//
// emptyStates   — "No X yet / found / recorded …", "Nothing to show", "— no data —" style lines
// offBanners    — "is off", "disabled", "not configured", "builder off" style lines
// tableRows     — data rows across every table on the page (header rows excluded)
// dataRows      — tableRows that are not themselves an empty-state row
// numbers       — count of numeric figures in the main content (a dashboard has many)
// contentBottom — lowest visible element bottom inside the page content, in px from the top
// fill          — contentBottom / viewport height (≤ 0.45 means most of the first screen is blank)
module.exports = function density() {
  const root =
    document.querySelector('main .page') ||
    document.querySelector('main') ||
    document.querySelector('.page') ||
    document.body;
  const text = root.innerText || '';
  const emptyRe =
    /\b(No [A-Za-z0-9 ,'’\-\/·]{1,60}?(yet|found|recorded|available|to show|to display|configured|here|matched|match|returned|in this window|for this filter)\b[^\n]*|Nothing [a-z ]{1,40}[^\n]*|no data[^\n]*|Empty[^\n]{0,40})/gi;
  const offRe =
    /\b([A-Za-z ]{0,30}\bis (off|disabled|not configured|not enabled)\b[^\n]*|builder off|flag off|disabled\b[^\n]{0,60}|not configured[^\n]{0,60})/gi;
  const emptyStates = (text.match(emptyRe) || []).map((s) => s.trim().slice(0, 90));
  const offBanners = (text.match(offRe) || []).map((s) => s.trim().slice(0, 90));
  let tableRows = 0,
    dataRows = 0;
  root.querySelectorAll('table tbody tr, [role="row"]:not([role="columnheader"])').forEach((tr) => {
    if (tr.closest('thead')) return;
    tableRows++;
    const t = (tr.innerText || '').trim();
    if (t && !emptyRe.test(t)) dataRows++;
    emptyRe.lastIndex = 0;
  });
  const numbers = (text.match(/[-+]?\d[\d,]*(\.\d+)?%?/g) || []).length;
  let bottom = 0;
  const vh = window.innerHeight;
  root.querySelectorAll('*').forEach((el) => {
    if (el.closest('footer, .status-bar, .app-footer')) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed') return;
    if (!el.children.length || el.tagName === 'svg' || el.tagName === 'CANVAS')
      bottom = Math.max(bottom, r.bottom + window.scrollY);
  });
  return {
    emptyStates: [...new Set(emptyStates)].slice(0, 8),
    emptyCount: emptyStates.length,
    offBanners: [...new Set(offBanners)].slice(0, 6),
    tableRows,
    dataRows,
    numbers,
    textLen: text.length,
    contentBottom: Math.round(bottom),
    fill: Math.round((bottom / vh) * 100) / 100,
  };
};

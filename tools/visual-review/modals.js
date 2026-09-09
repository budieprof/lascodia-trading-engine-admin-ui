// Open every modal / drawer / overlay that has a SAFE trigger (forms, detail views, palettes —
// never an action button), screenshot the viewport, and measure how far off-centre the dialog is.
// Usage: JWT=... OUT=dir node modals.js
const { chromium } = require('@playwright/test');
const fs = require('fs');

const DIALOG_SEL = '[role="dialog"], dialog[open], .modal, .modal-card, .modal-panel, .dialog, .dialog-inner, .panel, .drawer, .annot-dialog, .detail-panel, .detail-card, .wizard, .palette, .bell-panel, .modal-dialog, .trade-chart-dialog';

const STEPS = [
  { url: '/dashboard', name: 'keyboard-help', act: async p => { await p.keyboard.press('?'); } },
  { url: '/dashboard', name: 'command-palette', act: async p => { await p.keyboard.press('Meta+K'); } },
  { url: '/dashboard', name: 'notification-bell', act: async p => { await p.locator('app-notification-bell button').first().click(); } },
  // Inline slide-down panel (.create-panel), not an overlay — "(no dialog found)"
  // is the correct result here, and so is the off-centre dx on economic-event-create
  // below, which is likewise an inline panel sitting in the sidebar-offset column.
  { url: '/orders', name: 'orders-create-form', act: async p => { await p.locator('app-page-header button.btn-primary, .page-header button.btn-primary, header button.btn-primary').first().click(); } },
  { url: '/trade-signals', name: 'create-signal-dialog', act: async p => { await p.locator('app-page-header button.btn-primary, .page-header button.btn-primary, header button.btn-primary').first().click(); } },
  { url: '/strategies', name: 'strategy-template-panel', act: async p => { await p.getByRole('button', { name: /template/i }).first().click(); } },
  { url: '/strategies', name: 'strategy-form', act: async p => { await p.getByRole('button', { name: /new strategy|create strategy|add strategy/i }).first().click(); } },
  // /admin/users is gated by requirePermission('users.manage') — without the
  // seeded permission catalogue the guard redirects and no Edit button exists.
  { url: '/admin/users', name: 'admin-user-edit', act: async p => { await p.getByRole('button', { name: /^edit$/i }).first().click(); } },
  { url: '/llm/invocations', name: 'llm-invocation-detail', act: async p => { await p.locator('tr.clickable, .clickable').first().click(); } },
  { url: '/economic-events', name: 'economic-event-create', act: async p => { await p.getByRole('button', { name: /add event/i }).first().click(); } },
  { url: '/rejections', name: 'rejections-drawer', act: async p => { await p.locator('tr.clickable, .clickable').first().click(); } },
  { url: '/spot-analysis', name: 'spot-analysis-detail', act: async p => { await p.locator('tbody tr').first().click(); } },
  { url: '/terminals', name: 'add-broker-wizard', act: async p => { await p.locator('.btn-add-broker').first().click(); } },
  { url: '/alerts', name: 'alert-create-rule', act: async p => { await p.getByRole('button', { name: /^\+ create rule$/i }).first().click(); } },
  // Fork lives on the template EDITOR route, not the list page.
  { url: '/prompt-templates/5', name: 'prompt-fork-modal', act: async p => { await p.getByRole('button', { name: /^fork$/i }).first().click(); } },
  // "Baseline floors" carries an explicit role="tab", so getByRole('button') never matches it.
  { url: '/spread-reactive', name: 'spread-floor-override', act: async p => { await p.getByRole('tab', { name: /^baseline floors$/i }).first().click(); await p.waitForTimeout(800); await p.getByRole('button', { name: /^\+ new override$/i }).first().click(); } },
  { url: '/audit-trail', name: 'audit-detail', act: async p => { await p.getByRole('button', { name: /^details$/i }).first().click(); } },
  // Only exact, known-safe labels above. Regex matching on pages with action buttons matched
  // "Launch instance" on the EA detail page once (its card mentions "chart") — the confirm
  // dialog was dismissed, nothing ran, but that is one heuristic too many for a live console.
];

(async () => {
  const token = process.env.JWT, out = process.env.OUT;
  const user = { id: 1, username: 'superadmin', displayName: 'Super Admin', firstName: 'Super', lastName: 'Admin',
    email: 'admin@local', isSuperAdmin: true, mustChangePassword: false, roles: ['Admin'], permissions: [] };
  // Same permission catalogue crawl.js seeds. Without it, permission-gated routes
  // (/admin/users needs users.manage) redirect to the dashboard before /admin/auth/me
  // answers, and the step below just times out waiting for a button that is not there.
  const perms = process.env.PERMS_FILE ? JSON.parse(fs.readFileSync(process.env.PERMS_FILE, 'utf8')) : [];
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await ctx.addInitScript(({ token, user, perms }) => {
    sessionStorage.setItem('lascodia.auth.token', token);
    sessionStorage.setItem('lascodia.auth.user', JSON.stringify(user));
    if (perms.length) sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(perms));
  }, { token, user, perms });
  const page = await ctx.newPage();
  const report = [];
  for (const s of STEPS) {
    const entry = { name: s.name, url: s.url };
    try {
      await page.goto('http://localhost:4200' + s.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await s.act(page);
      await page.waitForTimeout(1300);
      const m = await page.evaluate((sel) => {
        const vw = innerWidth, vh = innerHeight;
        const els = [...document.querySelectorAll(sel)].filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 40 && r.height > 40 && cs.visibility !== 'hidden' && cs.display !== 'none'; });
        // Prefer the highest z-index / last in DOM.
        const e = els.sort((a, b) => (Number(getComputedStyle(b).zIndex) || 0) - (Number(getComputedStyle(a).zIndex) || 0))[0] ?? els.at(-1);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        return { cls: e.className?.toString().slice(0, 60), tag: e.tagName, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          dxFromCenter: Math.round(cx - vw / 2), dyFromCenter: Math.round(cy - vh / 2), overflowsViewport: r.bottom > vh + 2 || r.right > vw + 2 || r.top < -2 || r.left < -2,
          anchoredRight: Math.abs(r.right - vw) < 4 && r.height >= vh - 4 };
      }, DIALOG_SEL);
      entry.dialog = m;
      await page.screenshot({ path: `${out}/modal.${s.name}.png`, fullPage: false });
      entry.shot = `modal.${s.name}.png`;
      await page.keyboard.press('Escape');
    } catch (e) { entry.error = String(e.message).slice(0, 160); }
    report.push(entry);
    console.log(`${entry.error ? 'ERR' : 'OK '} ${s.name}${entry.dialog ? ` dx=${entry.dialog.dxFromCenter} dy=${entry.dialog.dyFromCenter} ${entry.dialog.w}x${entry.dialog.h}${entry.dialog.overflowsViewport ? ' OVERFLOWS' : ''}${entry.dialog.anchoredRight ? ' drawer' : ''}` : ' (no dialog found)'}${entry.error ? ' ' + entry.error : ''}`);
  }
  fs.writeFileSync(`${out}/modals.json`, JSON.stringify(report, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });

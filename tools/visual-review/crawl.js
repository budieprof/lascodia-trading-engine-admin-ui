// Crawl every admin-UI route headlessly, screenshot it, and record what could be wrong with it.
// Usage: JWT=... OUT=dir URLS=file [BASE=http://localhost:8080] [WIDTH=1440] [TAG=desk] [THEME=dark] [TABS=1] node crawl.js
// BASE defaults to the live release on :8080 (Caddy proxies /api to the engine), so no dev server is needed.
const { chromium } = require('@playwright/test');
const { isReadPost } = require('./read-posts');
const fs = require('fs');

(async () => {
  const token = process.env.JWT,
    out = process.env.OUT,
    width = Number(process.env.WIDTH || 1440);
  const tag = process.env.TAG || 'desk';
  const BASE = process.env.BASE || 'http://localhost:8080';
  const theme = process.env.THEME || 'dark';
  const withTabs = process.env.TABS !== '0';
  // Engine calls go to :5081 directly (dev server) or through the same origin under /api (release).
  const isApi = (u) =>
    u.includes(':5081') || u.startsWith(BASE + '/api/') || u.startsWith(BASE + '/health');
  const short = (u) => u.replace('http://localhost:5081', '').replace(BASE, '');
  const urls = fs
    .readFileSync(process.env.URLS, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const user = { passportId: '1', firstName: 'Super', lastName: 'Admin', email: 'admin@local' };
  // The permission catalogue the engine returns for the superadmin from /admin/auth/me. Seeded
  // so role/permission guards do not redirect to the dashboard before that call answers.
  const perms = process.env.PERMS_FILE
    ? JSON.parse(fs.readFileSync(process.env.PERMS_FILE, 'utf8'))
    : [];

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
  // Engine WRITES are aborted (same rule as interact.js). The tab pass below clicks whatever
  // matches a tab-ish selector, and on 2026-10-19 that included /alerts' "Test all delivering" and
  // "Send test" buttons: two real Telegram test messages went out from an unblocked crawl.
  const blockedWrites = [];
  await ctx.route('**/*', (route) => {
    const req = route.request(),
      path = req.url().split('?')[0];
    if (
      isApi(path) &&
      !['GET', 'OPTIONS'].includes(req.method()) &&
      !isReadPost(req.method(), path)
    ) {
      blockedWrites.push(`${req.method()} ${short(path)}`);
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  await ctx.addInitScript(
    ({ token, user, perms, theme }) => {
      try {
        localStorage.setItem('lascodia.theme', theme);
      } catch {}
      if (location.pathname !== '/login') {
        sessionStorage.setItem('lascodia.auth.token', token);
        sessionStorage.setItem('lascodia.auth.user', JSON.stringify(user));
        if (perms.length) sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(perms));
      }
    },
    { token, user, perms, theme },
  );

  const report = [];
  const page = await ctx.newPage();
  let consoleErrors = [],
    apiFailures = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240));
  });
  page.on('response', (r) => {
    const u = r.url();
    if (isApi(u) && r.status() >= 400) apiFailures.push(`${r.status()} ${short(u)}`.slice(0, 200));
  });
  // ERR_ABORTED is the browser cancelling an in-flight call on navigation or a tab switch —
  // not a failure. Recording it as one made 30 routes look broken in the 2026-10-19 pass.
  page.on('requestfailed', (r) => {
    const u = r.url(),
      why = r.failure()?.errorText || '';
    if (isApi(u) && !/ERR_ABORTED/.test(why))
      apiFailures.push(`FAILED(${why}) ${short(u)}`.slice(0, 200));
  });

  for (const url of urls) {
    consoleErrors = [];
    apiFailures = [];
    const name = (url === '/' ? 'root' : url.replace(/^\//, '').replace(/[\/:]/g, '_')) + '.' + tag;
    const entry = { url, name, ok: true };
    try {
      try {
        await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 25000 });
      } catch (e) {
        entry.navNote = 'networkidle timeout; continued';
      }
      await page.waitForTimeout(1800);
      entry.finalUrl = page.url().replace(BASE, '');
      const facts = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const bad =
          text.match(/\bNaN\b|\bundefined\b|\[object Object\]|\bInvalid Date\b|\bnull\b/g) || [];
        const errs = (
          text.match(
            /Could not load[^\n]*|Failed to load[^\n]*|Something went wrong[^\n]*|Unauthori[sz]ed[^\n]*|Forbidden[^\n]*|Not Found[^\n]*/gi,
          ) || []
        ).slice(0, 5);
        const h1 = document.querySelector('h1')?.innerText?.trim() || '';
        const de = document.documentElement;
        return {
          h1,
          textLen: text.length,
          badTokens: bad.slice(0, 10),
          badCount: bad.length,
          loadErrors: errs,
          hOverflow: de.scrollWidth > de.clientWidth + 2,
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
          height: de.scrollHeight,
          emptyStates: (
            text.match(/No [a-z ]+ (yet|found|recorded|available)|Nothing [a-z ]+/gi) || []
          ).slice(0, 4),
        };
      });
      Object.assign(entry, facts);
      entry.consoleErrors = [
        ...new Set(consoleErrors.map((s) => s.replace(/\s+/g, ' ').slice(0, 160))),
      ].slice(0, 6);
      entry.apiFailures = [...new Set(apiFailures)].slice(0, 8);
      const h = Math.min(facts.height, 12000);
      await page.screenshot({
        path: `${out}/${name}.png`,
        fullPage: facts.height <= 12000,
        clip: facts.height > 12000 ? { x: 0, y: 0, width, height: h } : undefined,
      });
      entry.shot = `${name}.png`;

      // Tabs are navigation, not actions: click through each one and record what it shows.
      const tabs = page.locator(
        '[role="tab"], .tabs button, .tabs a, .tab-bar button, .tab-bar a, nav.tabs button, .subnav a, .pill-tabs button',
      );
      // Never "tab" onto something whose label names an action (belt and braces with the block).
      const ACTION =
        /test|send|save|delete|remove|clear|reset|apply|run|start|stop|enable|disable|approve|reject|flatten|kill|retry|replay|resolve|discard|sync|rotate|launch|trigger|engage|release|close|cancel|submit|activate|pause|resume/i;
      const tabCount = withTabs ? Math.min(await tabs.count(), 12) : 0;
      entry.tabs = [];
      for (let i = 1; i < tabCount; i++) {
        // index 0 is the already-captured default tab
        try {
          const t = tabs.nth(i);
          const label = (await t.innerText().catch(() => '')).trim().slice(0, 40);
          if (!label) continue;
          if (ACTION.test(label) && (await t.getAttribute('role')) !== 'tab') {
            entry.tabs.push({ index: i, label, skipped: 'action-like label, not a tab' });
            continue;
          }
          consoleErrors = [];
          apiFailures = [];
          await t.click({ timeout: 3000 });
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(900);
          const tf = await page.evaluate(() => {
            const text = document.body.innerText || '';
            const de = document.documentElement;
            return {
              badCount: (
                text.match(/\bNaN\b|\bundefined\b|\[object Object\]|\bInvalid Date\b/g) || []
              ).length,
              loadErrors: (text.match(/Could not load[^\n]*|Failed to load[^\n]*/gi) || []).slice(
                0,
                3,
              ),
              hOverflow: de.scrollWidth > de.clientWidth + 2,
              height: de.scrollHeight,
            };
          });
          const tname = `${name}.tab${i}`;
          await page.screenshot({
            path: `${out}/${tname}.png`,
            fullPage: tf.height <= 12000,
            clip: tf.height > 12000 ? { x: 0, y: 0, width, height: 12000 } : undefined,
          });
          entry.tabs.push({
            label,
            shot: `${tname}.png`,
            ...tf,
            consoleErrors: [
              ...new Set(consoleErrors.map((s) => s.replace(/\s+/g, ' ').slice(0, 160))),
            ].slice(0, 4),
            apiFailures: [...new Set(apiFailures)].slice(0, 6),
          });
        } catch (e) {
          entry.tabs.push({ index: i, error: String(e.message).slice(0, 120) });
        }
      }
    } catch (e) {
      entry.ok = false;
      entry.error = String(e.message).slice(0, 200);
    }
    report.push(entry);
    console.log(
      `${entry.ok ? 'OK ' : 'ERR'} ${url} -> ${entry.finalUrl || ''} h=${entry.height || '?'} bad=${entry.badCount || 0} api=${(entry.apiFailures || []).length} con=${(entry.consoleErrors || []).length}${entry.hOverflow ? ' HOVERFLOW' : ''}`,
    );
  }
  fs.writeFileSync(`${out}/crawl.${tag}.json`, JSON.stringify(report, null, 1));
  if (blockedWrites.length)
    console.log(
      `blocked ${blockedWrites.length} engine write(s): ${[...new Set(blockedWrites)].slice(0, 10).join(', ')}`,
    );
  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

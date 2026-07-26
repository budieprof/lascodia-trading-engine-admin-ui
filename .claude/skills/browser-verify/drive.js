// Drive the running admin UI in Chromium, authenticate with a dev token, visit
// each route, screenshot it, and report console/network errors.
//
// Usage (from the repo root, so require('playwright') resolves):
//   LASC_JWT="$(cat /tmp/lasc_ui_jwt.txt)" OUT=/tmp \
//     node .claude/skills/browser-verify/drive.js /conversations /dashboard
//
// Env:
//   LASC_JWT  (required) — dev JWT injected into sessionStorage['lascodia.auth.token']
//   OUT       (optional) — screenshot output dir (default /tmp)
//   BASE      (optional) — UI base URL (default http://localhost:4200)
//   HEADED    (optional) — set to 1 to watch the browser (default headless)
const { chromium } = require('playwright');

const token = (process.env.LASC_JWT || '').trim();
const OUT = process.env.OUT || '/tmp';
const BASE = (process.env.BASE || 'http://localhost:4200').replace(/\/$/, '');
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ['/'];
if (!token) { console.error('LASC_JWT is required'); process.exit(2); }

const slug = r => (r === '/' ? 'root' : r.replace(/^\//, '').replace(/[^\w]+/g, '_'));

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();

  // Set origin first, then inject the token so the app boots authenticated.
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate(t => sessionStorage.setItem('lascodia.auth.token', t), token);

  const report = {};
  for (const route of routes) {
    const errors = [];
    const failed = [];
    const onConsole = m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); };
    const onPageErr = e => errors.push('PAGEERR: ' + e.message.slice(0, 200));
    const onResp = r => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url().replace(BASE, '').replace('http://localhost:5081', '')); };
    page.on('console', onConsole); page.on('pageerror', onPageErr); page.on('response', onResp);

    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(4500); // let charts/data settle
    const shot = `${OUT}/ui_${slug(route)}.png`;
    await page.screenshot({ path: shot });
    report[route] = {
      finalUrl: page.url(),
      title: await page.title(),
      screenshot: shot,
      canvases: await page.evaluate(() => document.querySelectorAll('canvas,[_echarts_instance_]').length),
      bodyExcerpt: (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 500),
      failedRequests: [...new Set(failed)].slice(0, 15),
      consoleErrors: [...new Set(errors)].slice(0, 10),
    };
    page.off('console', onConsole); page.off('pageerror', onPageErr); page.off('response', onResp);
  }

  console.log(JSON.stringify(report, null, 2));
  await browser.close();
})().catch(e => { console.error('FATAL', e && e.message); process.exit(1); });

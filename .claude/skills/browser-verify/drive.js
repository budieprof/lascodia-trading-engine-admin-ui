// Drive the running admin UI in Chromium, authenticate, visit each route,
// screenshot it, and report console/network errors.
//
// Auth is the login form's passwordless Developer tab. The previous version
// minted an HS256 token from a hardcoded dev secret; that secret has drifted
// from the running engine, so every request came back 401 and the app bounced
// to /login — which reads as "the whole page is broken" rather than "auth
// failed". `onDevLogin()` posts a fixed identity and the engine returns a real
// token, so it is valid by construction.
//
// Usage (from the repo root, so require('playwright') resolves):
//   OUT=/tmp node .claude/skills/browser-verify/drive.js /conversations /dashboard
//
// Env:
//   OUT    (optional) — screenshot output dir (default /tmp)
//   BASE   (optional) — UI base URL. Default http://localhost:8080, the
//                       PUBLISHED release, which is what operators see. Use
//                       http://localhost:4200 for the dev server.
//   HEADED (optional) — set to 1 to watch the browser (default headless)
const { chromium } = require('playwright');

const OUT = process.env.OUT || '/tmp';
const BASE = (process.env.BASE || 'http://localhost:8080').replace(/\/$/, '');
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ['/'];

const slug = r => (r === '/' ? 'root' : r.replace(/^\//, '').replace(/[^\w]+/g, '_'));

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const page = await ctx.newPage();

  // Sign in through the Developer tab. Deliberately NOT a minted token — see
  // the header. `waitForURL` off /login is the completion signal; the redirect
  // target varies by role so matching on a specific route would be brittle.
  await page.goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByRole('tab', { name: /Developer/i }).click();
  await page.getByRole('button', { name: /Sign In/i }).click();
  await page.waitForURL(u => !u.pathname.startsWith('/login'), { timeout: 30000 });

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

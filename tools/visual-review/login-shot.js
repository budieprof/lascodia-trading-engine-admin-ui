// Screenshot the login page (no session) in both themes, desktop and phone width.
// Usage: OUT=dir [BASE=http://localhost:8080] node login-shot.js
const { chromium } = require('@playwright/test');
(async () => {
  const out = process.env.OUT,
    BASE = process.env.BASE || 'http://localhost:8080';
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light'])
    for (const [w, h, tag] of [
      [1440, 900, 'desk'],
      [390, 844, 'phone'],
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        colorScheme: theme,
      });
      await ctx.addInitScript((t) => {
        try {
          localStorage.setItem('lascodia.theme', t);
        } catch {}
      }, theme);
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errs.push(m.text().slice(0, 160));
      });
      await page
        .goto(BASE + '/login', { waitUntil: 'networkidle', timeout: 20000 })
        .catch(() => {});
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${out}/login.${theme}.${tag}.png`, fullPage: true });
      console.log(`login ${theme} ${tag} console=${JSON.stringify(errs)}`);
      await ctx.close();
    }
  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

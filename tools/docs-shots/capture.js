// Capture the help portal's screenshots (public/docs-content/img/<name>.<light|dark>.webp) from the
// running console, with numbered markers drawn on them, in both themes.
//
// Usage (from the repo root; engine on :5081, console on BASE):
//   JWT_FILE=path/to/token NODE_PATH="$PWD/node_modules" node tools/docs-shots/capture.js [--only a,b] [--guide slug] [--theme light|dark|both]
//   BASE defaults to the live release (http://localhost:8080). To shoot an unpublished build, run
//   tools/visual-review/serve-dist.js and pass BASE=http://localhost:4300.
//
// Shots are described in tools/docs-shots/shots/<guide slug>.json — see README.md there.
//
// SAFETY: this drives the LIVE console. Every engine write is aborted at the network layer (the same
// rule as tools/visual-review: only GETs, read-style POSTs and SignalR negotiate get through), so a
// mis-aimed click in a shot's steps cannot place an order, send an alert or change a setting.
// PRIVACY: guides are read by every organisation, so each page is scrubbed before it is captured —
// e-mail addresses, long numbers (account logins, ids) and the operator's name are replaced, and a
// shot's `mask` elements are blurred. Look at every image before publishing it anyway.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { isReadPost } = require('../visual-review/read-posts');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'public/docs-content/img');
const SHOTS = path.join(__dirname, 'shots');
const BASE = process.env.BASE || 'http://localhost:8080';
const MAX_WIDTH = 1640; // output pixels; crops of small areas keep their 2x sharpness
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')?.split(',');
const guideOnly = arg('--guide')?.split(',');
const themes = (arg('--theme') || 'both') === 'both' ? ['light', 'dark'] : [arg('--theme')];

const token = fs.readFileSync(process.env.JWT_FILE, 'utf8').trim();
const isApi = (u) =>
  u.startsWith(BASE + '/api/') || u.startsWith(BASE + '/health') || u.includes(':5081');

function loadShots() {
  const all = [];
  for (const f of fs
    .readdirSync(SHOTS)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    const guide = f.replace(/\.json$/, '');
    if (guideOnly && !guideOnly.includes(guide)) continue;
    for (const s of JSON.parse(fs.readFileSync(path.join(SHOTS, f), 'utf8')))
      if (!only || only.includes(s.name)) all.push({ ...s, guide });
  }
  return all;
}

/** Every permission key the console knows (so every page and button the guides show is visible). */
const PERMISSIONS = [
  ...fs
    .readFileSync(path.join(ROOT, 'src/app/core/auth/permissions.generated.ts'), 'utf8')
    .matchAll(/key: '([a-z0-9_.:-]+)'/g),
].map((m) => m[1]);

function fakeSession() {
  const now = new Date();
  return {
    user: { id: 1, username: 'alex', displayName: 'Alex Morgan', email: 'alex@example.com' },
    activeTenant: { id: 1, slug: 'example', name: 'Example Trading', kind: 'Customer' },
    memberships: [{ tenantId: 1, slug: 'example', name: 'Example Trading', status: 'Active' }],
    permissions: PERMISSIONS,
    isPlatformStaff: true,
    impersonation: null,
    csrfToken: 'docs-shots',
    mfa: { satisfied: true, authTimeUtc: now.toISOString() },
    sessionId: 'docs-shots',
    expiresAtUtc: new Date(now.getTime() + 8 * 3600e3).toISOString(),
    idleTimeoutSeconds: 8 * 3600,
  };
}

/** Runs in the page: replace personal details in every text node and input. */
function scrub({ extra, keepMoney }) {
  // Money (balances, P&L, equity) keeps its shape and sign but not its digits. Prices are left alone:
  // they carry no currency sign and are public market data.
  const shuffle = (num) => {
    let i = 0;
    return num.replace(/\d/g, (d) =>
      String((Number(d) * 7 + i++ * 3 + 5) % 10 || (i === 1 ? 4 : 0)),
    );
  };
  const money = keepMoney
    ? []
    : [
        [/([$€£¥]\s?-?)([\d,]+(?:\.\d+)?)/g, (_, sign, n) => sign + shuffle(n)],
        [
          /(-?)([\d,]+\.\d{2})(\s?(?:USD|EUR|GBP|USDT|JPY)\b)/g,
          (_, m, n, cur) => m + shuffle(n) + cur,
        ],
      ];
  const rules = [
    ...money,
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'alex@example.com'],
    [/\bOlabode\b/gi, 'Alex'],
    [/\bOlaleye\b/gi, 'Morgan'],
    [/budie\w*/gi, 'alex'],
    [/\bMichael\b/g, 'Sam'],
    // IPv4 addresses (where a terminal signed in from) → the documentation range.
    [
      /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g,
      (_, a, b, c, d) => `203.0.113.${(Number(d) % 200) + 10}`,
    ],
    // Long bare numbers are account logins, broker ids, phone numbers: keep the length, not the digits.
    [/(?<![\d.,:])\d{7,}(?![\d.,])/g, (m) => '4' + '8150372946'.repeat(3).slice(0, m.length - 1)],
    ...extra.map(([a, b]) => [new RegExp(a, 'gi'), b]),
  ];
  const fix = (s) => rules.reduce((t, [re, to]) => t.replace(re, to), s);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const v = fix(n.nodeValue);
    if (v !== n.nodeValue) n.nodeValue = v;
  }
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.type === 'password') continue;
    const v = fix(el.value);
    if (v !== el.value) el.value = v;
    if (el.placeholder) el.placeholder = fix(el.placeholder);
  }
}

/** Runs in the page: numbered outlines (and an optional spotlight) over the marked elements. */
function drawMarks({ marks, spotlight }) {
  const layer = document.createElement('div');
  layer.id = '__docmarks';
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  const found = [];
  marks.forEach((m, i) => {
    const el = findEl(m);
    if (!el) return found.push(false);
    found.push(true);
    const r = el.getBoundingClientRect();
    const pad = m.pad ?? 4;
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;border:3px solid #ff5a1f;border-radius:10px;box-shadow:0 0 0 4px rgba(255,90,31,.22)${spotlight && i === 0 ? ',0 0 0 9999px rgba(10,12,20,.42)' : ''};`;
    layer.appendChild(box);
    if (m.n != null) {
      const b = document.createElement('div');
      const left = Math.max(4, r.left - pad - 14);
      const top = Math.max(4, r.top - pad - 14);
      b.textContent = String(m.n);
      b.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:28px;height:28px;border-radius:50%;background:#ff5a1f;color:#fff;font:700 15px/28px -apple-system,system-ui,sans-serif;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35);border:2px solid #fff;`;
      layer.appendChild(b);
      if (m.label) {
        const l = document.createElement('div');
        l.textContent = m.label;
        l.style.cssText = `position:fixed;left:${left + 34}px;top:${top + 1}px;padding:3px 10px;border-radius:8px;background:#ff5a1f;color:#fff;font:600 13px/20px -apple-system,system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3);`;
        layer.appendChild(l);
      }
    }
  });
  document.body.appendChild(layer);
  return found;

  function findEl(m) {
    const els = [...document.querySelectorAll(m.sel || '*')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!m.text) return els[m.nth ?? 0] ?? null;
    const want = m.text.toLowerCase();
    const matches = els.filter((e) =>
      (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().startsWith(want),
    );
    // The innermost element whose text matches (not every ancestor of it).
    const inner = matches.filter((e) => !matches.some((o) => o !== e && e.contains(o)));
    return inner[m.nth ?? 0] ?? null;
  }
}

async function runStep(page, s) {
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.waitFor) await page.locator(s.waitFor).first().waitFor({ timeout: 15000 });
  if (s.click) await page.locator(s.click).first().click({ timeout: 8000 });
  if (s.clickText)
    await page.getByText(s.clickText, { exact: !!s.exact }).first().click({ timeout: 8000 });
  if (s.clickRole)
    await page.getByRole(s.clickRole[0], { name: s.clickRole[1] }).first().click({ timeout: 8000 });
  if (s.hover) await page.locator(s.hover).first().hover({ timeout: 8000 });
  if (s.fill) await page.locator(s.fill[0]).first().fill(s.fill[1], { timeout: 8000 });
  if (s.press) await page.keyboard.press(s.press);
  if (s.scroll) await page.locator(s.scroll).first().scrollIntoViewIfNeeded({ timeout: 8000 });
  if (s.scrollY != null) await page.evaluate((y) => window.scrollTo(0, y), s.scrollY);
  if (s.eval) await page.evaluate(s.eval); // a fixed snippet from the shot file (e.g. open a <details>)
}

async function toWebp(convPage, png, width) {
  return Buffer.from(
    await convPage.evaluate(
      async ({ b64, max }) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const scale = Math.min(1, max / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL('image/webp', 0.86).split(',')[1];
      },
      { b64: png.toString('base64'), max: width },
    ),
    'base64',
  );
}

(async () => {
  const shots = loadShots();
  if (!shots.length) return console.error('no shots matched');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const conv = await (await browser.newContext()).newPage();
  const report = [];
  const blocked = [];

  for (const theme of themes) {
    for (const shot of shots) {
      const [w, h] = shot.viewport || [1440, 900];
      const ctx = await browser.newContext({
        viewport: { width: w, height: h },
        deviceScaleFactor: 2,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await ctx.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        const p = url.split('?')[0];
        // Signed in the way customers are (the BFF session), as a stand-in session: the console gets a
        // made-up person in "Example Trading" holding every permission, and each engine request carries
        // the read-only screenshot token instead of the session cookie.
        if (!shot.noAuth && p.startsWith(BASE + '/bff/')) {
          if (p.endsWith('/bff/session')) return route.fulfill({ json: fakeSession() });
          if (p.endsWith('/bff/ws-ticket'))
            return route.fulfill({ json: { ticket: token, expiresInSeconds: 30 } });
          return route.fulfill({ status: 204, body: '' });
        }
        // Closing the chart's own script sessions is let through: blocked, they would linger until the
        // engine's idle timeout and count against the operator's per-person session cap.
        const closesScriptSession =
          req.method() === 'DELETE' && /\/scripting\/sessions\/[0-9a-f]+$/.test(p);
        if (
          isApi(p) &&
          !['GET', 'OPTIONS'].includes(req.method()) &&
          !isReadPost(req.method(), p) &&
          !closesScriptSession
        ) {
          blocked.push(`${shot.name}: ${req.method()} ${p.replace(BASE, '')}`);
          return route.abort('blockedbyclient');
        }
        if (!shot.noAuth && isApi(p))
          return route.continue({
            headers: { ...req.headers(), authorization: `Bearer ${token}` },
          });
        return route.continue();
      });
      await ctx.addInitScript(
        ({ theme }) => {
          try {
            localStorage.setItem('lascodia.theme', theme);
          } catch {}
          // Live updates: the console sends its one-use session ticket as `?ticket=`; the stand-in
          // session's "ticket" is the screenshot token, which the engine reads as `?access_token=`.
          const Native = window.WebSocket;
          const Patched = function (url, protocols) {
            return new Native(String(url).replace(/([?&])ticket=/, '$1access_token='), protocols);
          };
          Patched.prototype = Native.prototype;
          Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
          window.WebSocket = Patched;
        },
        { theme },
      );
      const page = await ctx.newPage();
      const entry = { name: shot.name, theme, ok: true, notes: [] };
      const failures = new Set();
      page.on('response', (r) => {
        if (isApi(r.url()) && r.status() >= 400)
          failures.add(
            `${r.status()} ${r.request().method()} ${r.url().replace(BASE, '').split('?')[0]}`,
          );
      });
      page.on('websocket', (ws) =>
        ws.on('close', () =>
          failures.add(
            `ws closed ${ws
              .url()
              .replace(/access_token=[^&]+/, 'access_token=…')
              .replace(/^wss?:\/\/[^/]+/, '')}`,
          ),
        ),
      );
      try {
        await page
          .goto(BASE + shot.route, { waitUntil: 'networkidle', timeout: 30000 })
          .catch(() => entry.notes.push('networkidle timeout'));
        await page.waitForTimeout(shot.settle ?? 2500);
        for (const s of shot.steps || []) {
          try {
            await runStep(page, s);
          } catch (e) {
            entry.notes.push(
              `step ${JSON.stringify(s).slice(0, 80)} failed: ${e.message.split('\n')[0]}`,
            );
          }
        }
        await page.waitForTimeout(shot.after ?? 600);
        // Hide what is not part of the lesson: toasts, the assistant button, the update pill.
        await page.addStyleTag({
          content: [
            '.toast-container, app-toast, .cdk-overlay-container .toast, .assistant-fab, app-assistant-dock .fab, app-footer-version-pill { visibility: hidden !important; }',
            '*, *::before, *::after { caret-color: transparent !important; }',
            ...(shot.hide || []).map((s) => `${s} { visibility: hidden !important; }`),
            ...(shot.mask || []).map((s) => `${s} { filter: blur(6px) !important; }`),
          ].join('\n'),
        });
        await page.evaluate(scrub, { extra: shot.replace || [], keepMoney: !!shot.keepMoney });
        const target = shot.crop?.sel;
        if (target) {
          await page
            .locator(target)
            .first()
            .scrollIntoViewIfNeeded()
            .catch(() => {});
        } else if (shot.marks?.[0]?.scrollTo) {
          await page
            .locator(shot.marks[0].sel)
            .first()
            .scrollIntoViewIfNeeded()
            .catch(() => {});
        }
        if (shot.marks?.length) {
          const found = await page.evaluate(drawMarks, {
            marks: shot.marks,
            spotlight: !!shot.spotlight,
          });
          found.forEach(
            (ok, i) =>
              ok || entry.notes.push(`mark ${i + 1} not found: ${JSON.stringify(shot.marks[i])}`),
          );
        }
        let clip;
        if (target) {
          const box = await page.locator(target).first().boundingBox();
          if (box) {
            const pad = shot.crop.pad ?? 24;
            const x = Math.max(0, box.x - pad);
            const y = Math.max(0, box.y - pad);
            clip = {
              x,
              y,
              width: Math.min(w - x, box.width + pad * 2),
              height: Math.min(h - y, box.height + pad * 2),
            };
          } else entry.notes.push(`crop target not found: ${target}`);
        } else if (shot.clip) {
          clip = { x: shot.clip[0], y: shot.clip[1], width: shot.clip[2], height: shot.clip[3] };
        }
        const png = await page.screenshot({ clip, animations: 'disabled' });
        const webp = await toWebp(conv, png, MAX_WIDTH);
        const file = path.join(OUT, `${shot.name}.${theme}.webp`);
        fs.writeFileSync(file, webp);
        entry.kb = Math.round(webp.length / 1024);
        const text = await page.evaluate(() => document.body.innerText);
        if (
          /\bNaN\b|\bundefined\b|\[object Object\]|Could not load|Something went wrong/.test(text)
        )
          entry.notes.push('page text has an error-looking token — check the image');
      } catch (e) {
        entry.ok = false;
        entry.notes.push(e.message.split('\n')[0]);
      }
      if (failures.size)
        entry.notes.push(`engine said no: ${[...failures].slice(0, 6).join(', ')}`);
      report.push(entry);
      console.log(
        `${entry.ok ? '✓' : '✗'} ${shot.guide}/${shot.name} [${theme}] ${entry.kb ?? '-'} kB ${entry.notes.join(' | ')}`,
      );
      await ctx.close();
    }
  }
  await browser.close();
  if (blocked.length)
    console.log(
      `\nblocked ${blocked.length} engine writes:\n  ` + [...new Set(blocked)].join('\n  '),
    );
  process.exitCode = report.every((r) => r.ok) ? 0 : 1;
})();

// Click through the buttons on every admin-UI route with every engine WRITE blocked at the network
// layer, and record what each click does: opens a dialog/menu, navigates, would have written without
// asking first, or does nothing visible at all.
//
// Usage: JWT=... OUT=dir URLS=file [BASE=http://localhost:8080] [PERMS_FILE=perms.json] [MAX=20] node interact.js
//
// SAFETY. This runs against the LIVE console, so two independent layers keep it read-only:
//   1. Every non-GET request to the engine is aborted unless read-posts.js lists it as a read
//      (the /list|/paged|/query|/summary convention plus routes verified to send a *Query) or it is
//      the SignalR negotiate call.
//      Aborted writes are recorded per click — a write that fires straight from a button with no
//      confirmation step is itself a finding.
//   2. Buttons whose label names an action (save, delete, flatten, launch, …) are never clicked.
// Do not loosen either layer. The denylist alone is not enough: labels drift, icon buttons have none.
const { chromium } = require('@playwright/test');
const { isReadPost } = require('./read-posts');
const fs = require('fs');

const DENY =
  /flatten|kill|launch|restart|delete|remove|retire|promote|approve|reject|emergency|panic|shut ?down|release|clear|apply|execute|trigger|\brun\b|start|stop|submit|save|send|confirm|deactivate|activate|enable|disable|pause|resume|reset|rollback|revert|publish|deploy|import|sync|log ?out|sign ?out|accept|dismiss|acknowledge|\back\b|archive|purge|retry|requeue|replay|backfill|train|optimi[sz]e|tune|\barm\b|disarm|halt|override|force|liquidat|hedge|\bbuy\b|\bsell\b|place|modify|cancel|close|download|export|copy|upload|generate|create backtest|re-?run|rerun|mark|resolve|snooze|mute|unmute|pin|unpin|fork|duplicate|clone|restore|seed|recompute|rebuild|refit|retest|evaluate|kick|wake|nudge|lock|unlock|grant|revoke|invite|terminate|abort|compile|backtest now|go live|paper|live/i;
const OVERLAY_SEL =
  '[role="dialog"], dialog[open], dialog:modal, [role="menu"], [role="listbox"], .modal, .modal-card, .modal-panel, .dialog, .drawer, .popover, .dropdown-menu, .menu-panel, .detail-panel, .wizard, .palette, .cdk-overlay-pane';

(async () => {
  const token = process.env.JWT,
    out = process.env.OUT,
    BASE = process.env.BASE || 'http://localhost:8080';
  const MAX = Number(process.env.MAX || 20);
  const urls = fs
    .readFileSync(process.env.URLS, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const perms = process.env.PERMS_FILE
    ? JSON.parse(fs.readFileSync(process.env.PERMS_FILE, 'utf8'))
    : [];
  const user = { passportId: '1', firstName: 'Super', lastName: 'Admin', email: 'admin@local' };
  const isApi = (u) =>
    u.includes(':5081') || u.startsWith(BASE + '/api/') || u.startsWith(BASE + '/health');
  const short = (u) => u.replace('http://localhost:5081', '').replace(BASE, '').slice(0, 160);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  await ctx.addInitScript(
    ({ token, user, perms }) => {
      try {
        localStorage.setItem('lascodia.theme', 'dark');
      } catch {}
      sessionStorage.setItem('lascodia.auth.token', token);
      sessionStorage.setItem('lascodia.auth.user', JSON.stringify(user));
      if (perms.length) sessionStorage.setItem('lascodia.auth.perms', JSON.stringify(perms));
      // Count DOM mutations so a click that changes nothing can be told apart from one that does.
      window.__mut = 0;
      new MutationObserver((ms) => {
        window.__mut += ms.length;
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    },
    { token, user, perms },
  );

  let blocked = [],
    apiFailures = [],
    consoleErrors = [];
  await ctx.route('**/*', (route) => {
    const req = route.request(),
      u = req.url();
    if (isApi(u) && req.method() !== 'GET' && req.method() !== 'OPTIONS') {
      const path = u.split('?')[0];
      if (!isReadPost(req.method(), path)) {
        blocked.push(`${req.method()} ${short(u)}`);
        return route.abort('blockedbyclient');
      }
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
  });
  page.on('response', (r) => {
    if (isApi(r.url()) && r.status() >= 400) apiFailures.push(`${r.status()} ${short(r.url())}`);
  });
  page.on('dialog', (d) => d.dismiss().catch(() => {})); // window.confirm/alert: always say no

  const report = [];
  for (const url of urls) {
    const pageName = url.replace(/^\//, '').replace(/[\/:]/g, '_') || 'root';
    const entry = { url, clicks: [] };
    const load = async () => {
      await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1200);
    };
    // Distinct, visible, enabled buttons in the page body (not the shell), first of each label.
    // Re-run after every reload: the data-vr-idx marks die with the DOM they were set on.
    const tag = () =>
      page.evaluate(
        ({ deny }) => {
          const re = new RegExp(deny, 'i');
          const root = document.querySelector('main') || document.body;
          // Clear the previous pass's marks first: after a reload or re-render, a stale mark left on a
          // different element made the next lookup click the wrong control.
          document
            .querySelectorAll('[data-vr-idx]')
            .forEach((el) => el.removeAttribute('data-vr-idx'));
          const els = [...root.querySelectorAll('button, [role="button"], a.btn, summary')];
          const seen = new Set(),
            outList = [];
          els.forEach((el, i) => {
            const r = el.getBoundingClientRect(),
              cs = getComputedStyle(el);
            if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none')
              return;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
            if (el.closest('[role="tablist"]') || el.getAttribute('role') === 'tab') return; // crawl.js covers tabs
            if (
              el.closest(
                'app-sidebar, app-header, app-breadcrumbs, app-footer-version-pill, .ag-header, .ag-paging-panel',
              )
            )
              return;
            const label = (
              el.innerText ||
              el.getAttribute('aria-label') ||
              el.getAttribute('title') ||
              ''
            )
              .trim()
              .replace(/\s+/g, ' ')
              .slice(0, 60);
            if (re.test(label)) return;
            const key = label || `[icon:${el.className?.toString().slice(0, 30)}]`;
            if (seen.has(key)) return;
            seen.add(key);
            el.setAttribute('data-vr-idx', String(i));
            outList.push({ idx: i, label: key, tag: el.tagName.toLowerCase() });
          });
          return outList;
        },
        { deny: DENY.source },
      );
    try {
      await load();
      const candidates = await tag();
      // The latest tagging of the live DOM; refreshed after every reload. Candidates are matched
      // to it by LABEL — an index from an earlier tagging can name a different element now.
      let current = candidates;
      entry.candidateCount = candidates.length;

      for (const c of candidates.slice(0, MAX)) {
        blocked = [];
        apiFailures = [];
        consoleErrors = [];
        const click = { label: c.label };
        try {
          // Visible overlays only — the same filter as the after-count below. A page that keeps a
          // hidden dialog element in its markup (/ea-instances did) otherwise never registers a
          // dialog as opened, Escape is never pressed, and every later click on it times out.
          const before = await page.evaluate(
            (sel) => ({
              overlays: [...document.querySelectorAll(sel)].filter((e) => {
                const r = e.getBoundingClientRect(),
                  cs = getComputedStyle(e);
                return (
                  r.width > 30 &&
                  r.height > 20 &&
                  cs.visibility !== 'hidden' &&
                  cs.display !== 'none'
                );
              }).length,
              url: location.pathname + location.search,
            }),
            OVERLAY_SEL,
          );
          let now = current.find((x) => x.label === c.label);
          if (!now || (await page.locator(`[data-vr-idx="${now.idx}"]`).count()) === 0) {
            current = await tag();
            now = current.find((x) => x.label === c.label);
          }
          if (!now) {
            click.skipped = 'gone after an earlier click';
            entry.clicks.push(click);
            continue;
          }
          const loc = page.locator(`[data-vr-idx="${now.idx}"]`);
          await page.evaluate(() => {
            window.__mut = 0;
          });
          await loc.first().click({ timeout: 2500 });
          await page.waitForTimeout(1100);
          const after = await page.evaluate((sel) => {
            const vis = [...document.querySelectorAll(sel)].filter((e) => {
              const r = e.getBoundingClientRect();
              const cs = getComputedStyle(e);
              return (
                r.width > 30 && r.height > 20 && cs.visibility !== 'hidden' && cs.display !== 'none'
              );
            });
            const top = vis.at(-1);
            let geo = null,
              text = '';
            if (top) {
              const r = top.getBoundingClientRect();
              geo = {
                cls: top.className?.toString().slice(0, 50),
                role: top.getAttribute('role'),
                x: Math.round(r.left),
                y: Math.round(r.top),
                w: Math.round(r.width),
                h: Math.round(r.height),
                offscreen:
                  r.bottom > innerHeight + 2 ||
                  r.right > innerWidth + 2 ||
                  r.top < -2 ||
                  r.left < -2,
              };
              text = top.innerText || '';
            }
            return {
              overlays: vis.length,
              url: location.pathname + location.search,
              mut: window.__mut,
              geo,
              bad: (
                text.match(/\bNaN\b|\bundefined\b|\[object Object\]|\bInvalid Date\b|\bnull\b/g) ||
                []
              ).slice(0, 5),
            };
          }, OVERLAY_SEL);
          click.mutations = after.mut;
          if (after.url !== before.url) click.navigatedTo = after.url;
          if (after.overlays > before.overlays && after.geo) {
            click.opened = after.geo;
            click.badTokens = after.bad;
          }
          if (blocked.length) click.blockedWrites = [...new Set(blocked)].slice(0, 4);
          if (apiFailures.length) click.apiFailures = [...new Set(apiFailures)].slice(0, 4);
          if (consoleErrors.length) click.consoleErrors = [...new Set(consoleErrors)].slice(0, 3);
          if (!click.navigatedTo && !click.opened && !blocked.length && after.mut === 0)
            click.noEffect = true;
          if (click.opened || click.blockedWrites || click.consoleErrors) {
            const shot = `${pageName}__${c.label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`;
            await page.screenshot({ path: `${out}/${shot}`, fullPage: false });
            click.shot = shot;
          }
          // Put the page back: close whatever opened, or reload if the click navigated.
          if (click.navigatedTo) {
            await load();
            current = await tag();
          } else if (click.opened) {
            // Count VISIBLE overlays after an exit animation has had time to finish — a bare
            // element count at 300 ms reported dialogs that were already fading out.
            await page.keyboard.press('Escape');
            await page.waitForTimeout(900);
            const still = await page.evaluate(
              (sel) =>
                [...document.querySelectorAll(sel)].filter((e) => {
                  const r = e.getBoundingClientRect(),
                    cs = getComputedStyle(e);
                  return (
                    r.width > 30 &&
                    r.height > 20 &&
                    cs.visibility !== 'hidden' &&
                    cs.display !== 'none' &&
                    cs.opacity !== '0'
                  );
                }).length,
              OVERLAY_SEL,
            );
            if (still >= after.overlays) {
              click.escapeDidNotClose = true;
              await load();
              current = await tag();
            }
          }
        } catch (e) {
          click.error = String(e.message).split('\n')[0].slice(0, 140);
        }
        entry.clicks.push(click);
      }
    } catch (e) {
      entry.error = String(e.message).slice(0, 200);
    }
    report.push(entry);
    const n = (k) => entry.clicks.filter((c) => c[k]).length;
    console.log(
      `${url} candidates=${entry.candidateCount ?? '?'} opened=${n('opened')} nav=${n('navigatedTo')} writes=${n('blockedWrites')} dead=${n('noEffect')} err=${n('error')} con=${n('consoleErrors')}`,
    );
    fs.writeFileSync(`${out}/interact.json`, JSON.stringify(report, null, 1));
  }
  await browser.close();
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});

// Helpers for driving the admin UI beyond a route smoke test.
//
// `drive.js` answers "does this page load without errors". These answer the harder
// questions that came up building the chart-analysis page and the assistant:
//
//   - did this control ACTUALLY paint, or did it just not throw?
//   - what bytes is the app really sending?
//   - can I exercise a feature that needs screen sharing?
//
// Require from the repo root so playwright resolves:
//   const { login, paintHash, capturePosted, launch } = require('./.claude/skills/browser-verify/verify-lib');

const crypto = require('crypto');

const BASE = process.env.BASE || 'http://localhost:8080';

/**
 * Launch Chromium.
 *
 * `screen: true` is NOT a convenience flag — getDisplayMedia returns
 * NotSupportedError in headless Chromium under EVERY flag combination, so anything
 * touching screen capture has to run headed. The auto-accept flags then stand in for the
 * picker no script can click.
 */
async function launch(chromium, { screen = false, headed = false } = {}) {
  return chromium.launch({
    headless: !(screen || headed),
    args: screen
      ? ['--auto-accept-this-tab-capture', '--auto-select-tab-capture-source-by-title=Lascodia']
      : [],
  });
}

/**
 * Sign in via the login form's passwordless Developer tab.
 *
 * Do NOT hand-mint a JWT: the hardcoded dev secret has drifted from the running engine, so
 * every request comes back 401 and the app bounces to /login — which reads as "the whole
 * page is broken" rather than "auth failed", and is exactly how it wastes an hour.
 */
async function login(page, base = BASE) {
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Developer/i }).click();
  await page.getByRole('button', { name: /Sign In/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20000 });
}

/**
 * A hash of one region's pixels — the "did it actually paint?" test.
 *
 * Markets are closed at weekends, which makes the chart canvas STATIC between actions; that
 * is what makes a before/after hash meaningful rather than noise. This is how the anchored
 * volume profile was caught drawing nothing: its object count went up and no histogram
 * appeared.
 *
 * Careful: a changed hash proves SOMETHING changed, not that the right thing did. The
 * profile bug briefly passed because the tool's anchor line moved pixels. When a component
 * must render specific content, screenshot it and LOOK.
 */
async function paintHash(locator) {
  return crypto.createHash('sha1').update(await locator.screenshot()).digest('hex').slice(0, 12);
}

/**
 * Capture what the app POSTs to a matching URL, so a claim about the payload is settled by
 * the wire rather than by reading the code.
 *
 * Returns a live array; each entry is the parsed JSON body.
 */
function capturePosted(page, urlSubstring) {
  const seen = [];
  page.on('request', (req) => {
    if (!req.url().includes(urlSubstring)) return;
    try {
      seen.push(JSON.parse(req.postData() || '{}'));
    } catch {
      /* not JSON — not what we are watching for */
    }
  });
  return seen;
}

/** Collect console errors, minus the known-benign cold-session noise. */
function collectErrors(page) {
  const errors = [];
  const benign = /whoami|401|camera is not allowed/i;
  page.on('console', (m) => m.type() === 'error' && !benign.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

/**
 * Drive a menu button to a KNOWN state instead of clicking blind.
 *
 * Most menus here toggle. A blind click is a coin flip on whether the menu ends up open, and
 * a loop that opens-then-clicks will silently close it on every other pass.
 */
async function ensureOpen(page, buttonLocator, panelLocator, tries = 3) {
  for (let i = 0; i < tries; i++) {
    if (await panelLocator.isVisible().catch(() => false)) return true;
    await buttonLocator.click();
    await page.waitForTimeout(350);
  }
  return panelLocator.isVisible().catch(() => false);
}

/**
 * Let the assistant see the page.
 *
 * <p>Default `page` mode renders the DOM in-process: no permission prompt, no sharing
 * banner, and it works HEADLESS. Only `screen` mode needs `launch({ screen: true })` and a
 * headed browser — `getDisplayMedia` throws NotSupportedError in headless Chromium under
 * every flag.</p>
 */
async function enableVision(page, mode = 'page') {
  const toggle = page.locator('button[aria-label="Let the assistant see this page"]');
  if ((await toggle.count()) === 0) return false;
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') {
    await toggle.click();
    await page.waitForTimeout(600);
  }
  const chip = page.locator('.vision-mode');
  if ((await chip.count()) && (await chip.textContent())?.trim() !== mode) {
    await chip.click();
    await page.waitForTimeout(3000);
  }
  return (await toggle.getAttribute('aria-pressed')) === 'true';
}

/** Open the assistant dock. */
async function openAssistant(page) {
  // '.fab' is the real class; '.assistant-fab' matches nothing and only ever worked because
  // of the :has-text fallback behind it.
  await page
    .locator('button[aria-label*="assistant" i], .fab, button:has-text("Ask")')
    .first()
    .click();
  await page.waitForTimeout(2000);
}

/**
 * The build the SERVED bundle is running.
 *
 * Check this first whenever a just-deployed fix is reported as not working: the console is
 * an SPA, so a tab open since before the publish keeps running the old JavaScript and will
 * reproduce a bug that is already fixed.
 */
async function servedRelease(page, base = BASE) {
  const res = await page.request.get(`${base}/config.json?_=${Date.now()}`);
  const body = await res.json().catch(() => ({}));
  return body.releaseId ?? null;
}

module.exports = {
  BASE,
  launch,
  login,
  paintHash,
  capturePosted,
  collectErrors,
  ensureOpen,
  enableVision,
  openAssistant,
  servedRelease,
};

// Signs a crawl in the way the console signs people in (the BFF session), with a stand-in session.
//
// The console asks `/bff/session` who is signed in and sends engine calls with the session cookie.
// A crawl has no cookie, so `installBffSession` answers `/bff/*` itself (the house organisation,
// every permission the console knows, platform staff) and adds the read-only crawl JWT to each engine
// call. The legacy sessionStorage token alone now ends at /login — every route of the 2026-10-28
// crawl did, which is why this exists. Same approach as tools/docs-shots/capture.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const PERMISSIONS = [
  ...fs
    .readFileSync(path.join(ROOT, 'src/app/core/auth/permissions.generated.ts'), 'utf8')
    .matchAll(/key: '([a-z0-9_.:-]+)'/g),
].map((m) => m[1]);

function session() {
  const now = new Date();
  return {
    user: { id: 1, username: 'superadmin', displayName: 'Super Admin', email: 'admin@local' },
    activeTenant: { id: 1, slug: 'house', name: 'House', kind: 'House' },
    memberships: [{ tenantId: 1, slug: 'house', name: 'House', status: 'Active' }],
    permissions: PERMISSIONS,
    isPlatformStaff: true,
    impersonation: null,
    csrfToken: 'visual-review',
    mfa: { satisfied: true, authTimeUtc: now.toISOString() },
    sessionId: 'visual-review',
    expiresAtUtc: new Date(now.getTime() + 8 * 3600e3).toISOString(),
    idleTimeoutSeconds: 8 * 3600,
  };
}

/**
 * Answers a `/bff/*` request, or returns false. Call it first inside the context's route handler.
 * `token` is the read-only crawl JWT; the WebSocket shim below turns the ticket into `access_token`.
 */
async function answerBff(route, base, token) {
  const p = route.request().url().split('?')[0];
  if (!p.startsWith(base + '/bff/')) return false;
  if (p.endsWith('/bff/session')) await route.fulfill({ json: session() });
  else if (p.endsWith('/bff/ws-ticket'))
    await route.fulfill({ json: { ticket: token, expiresInSeconds: 30 } });
  else await route.fulfill({ status: 204, body: '' });
  return true;
}

/** Init script: live updates send `?ticket=`; the engine reads the crawl JWT as `?access_token=`. */
function wsShim() {
  const Native = window.WebSocket;
  const Patched = function (url, protocols) {
    return new Native(String(url).replace(/([?&])ticket=/, '$1access_token='), protocols);
  };
  Patched.prototype = Native.prototype;
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Patched;
}

module.exports = { answerBff, wsShim, PERMISSIONS };

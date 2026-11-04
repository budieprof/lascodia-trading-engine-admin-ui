/**
 * Shown instead of the app when `config.json` could not be loaded (see `loadRuntimeConfig`).
 *
 * Plain DOM, no Angular: the app has not started, and starting it without its settings is exactly
 * what this screen replaces (it showed the retired password sign-in). Inline styles only — the
 * stylesheet may be what failed to arrive too. The page reloads itself after a pause, so a tablet
 * waking from sleep recovers without a tap.
 */
export const CONFIG_RETRY_RELOAD_MS = 20_000;

export function renderConfigUnavailableScreen(
  doc: Document = document,
  reload: () => void = () => location.reload(),
  autoReloadMs: number = CONFIG_RETRY_RELOAD_MS,
): void {
  const host = doc.querySelector('app-root') ?? doc.body;
  const wrap = doc.createElement('main');
  wrap.setAttribute('role', 'alert');
  wrap.setAttribute(
    'style',
    'min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'gap:12px;padding:24px;text-align:center;font-family:Inter,system-ui,-apple-system,sans-serif;' +
      'color:#1d1d1f;background:#f5f5f7',
  );

  const title = doc.createElement('h1');
  title.textContent = 'The console could not load';
  title.setAttribute('style', 'margin:0;font-size:22px;font-weight:600');

  const text = doc.createElement('p');
  text.textContent =
    'Its settings did not arrive. This is usually a brief network problem. ' +
    'The page will try again by itself in a few seconds.';
  text.setAttribute(
    'style',
    'margin:0;max-width:420px;font-size:14px;line-height:1.5;color:#515154',
  );

  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Try again now';
  button.setAttribute(
    'style',
    'margin-top:8px;padding:10px 22px;border:0;border-radius:999px;background:#0a84ff;color:#fff;' +
      'font-size:14px;font-weight:600;cursor:pointer',
  );
  button.addEventListener('click', () => reload());

  wrap.append(title, text, button);
  host.replaceChildren(wrap);

  if (autoReloadMs > 0) setTimeout(() => reload(), autoReloadMs);
}

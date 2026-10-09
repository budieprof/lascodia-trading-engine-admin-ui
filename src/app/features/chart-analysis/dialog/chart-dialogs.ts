import type { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';

/**
 * The chart page's questions in the console's own dialog (CC-I11) instead of the browser's `prompt()` / `confirm()`:
 * those block the page (ticks, replay and the assistant stop while they are open), cannot be styled or read by the
 * assistant's screen, and some browsers suppress them altogether.
 */

/**
 * Ask for a name. Resolves the trimmed text, or null when cancelled — or when the text is empty and `allowEmpty` is
 * not set (an empty name is never a valid answer here).
 */
export async function askName(
  dialogs: Pick<ScriptDialogService, 'ask'>,
  options: { title: string; message?: string; label: string; value: string; confirmLabel: string; maxLength?: number },
): Promise<string | null> {
  const r = await dialogs.ask({
    title: options.title,
    message: options.message ?? '',
    choices: [{ id: 'ok', label: options.confirmLabel }],
    field: { label: options.label, value: options.value, maxLength: options.maxLength ?? 100 },
  });
  if (r.choice !== 'ok') return null;
  const text = r.text.trim();
  return text ? text : null;
}

/** Ask before deleting something: true only for the delete button. */
export function confirmDelete(
  dialogs: Pick<ScriptDialogService, 'confirm'>,
  what: string,
  message = 'This cannot be undone.',
): Promise<boolean> {
  return dialogs.confirm({
    title: `Delete ${what}?`,
    message,
    confirmLabel: 'Delete',
    cancelLabel: 'Keep it',
    tone: 'danger',
  });
}

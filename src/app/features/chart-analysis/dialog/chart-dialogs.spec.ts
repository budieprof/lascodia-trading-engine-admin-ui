import { describe, expect, it, vi, type Mock } from 'vitest';
import type { ScriptDialogService } from '@features/scripting/shared/script-dialog.service';
import { askName, confirmDelete } from './chart-dialogs';

const dialogs = (choice: string | null, text = '') =>
  ({
    ask: vi.fn(() => Promise.resolve({ choice, text })),
    confirm: vi.fn(() => Promise.resolve(choice === 'confirm')),
  }) as unknown as ScriptDialogService & { ask: Mock; confirm: Mock };

describe('chart dialogs (CC-I11)', () => {
  it('asks for a name in the console dialog and answers it trimmed', async () => {
    const d = dialogs('ok', '  Scalping  ');
    const name = await askName(d, { title: 'New layout', label: 'Layout name', value: 'Unnamed', confirmLabel: 'Create' });
    expect(name).toBe('Scalping');
    expect(d.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'New layout',
        choices: [{ id: 'ok', label: 'Create' }],
        field: { label: 'Layout name', value: 'Unnamed', maxLength: 100 },
      }),
    );
  });

  it('answers null when cancelled or left empty', async () => {
    const opts = { title: 't', label: 'l', value: 'v', confirmLabel: 'OK' };
    expect(await askName(dialogs(null, 'kept'), opts)).toBeNull();
    expect(await askName(dialogs('ok', '   '), opts)).toBeNull();
  });

  it('asks before deleting, as a danger question', async () => {
    const d = dialogs('confirm');
    expect(await confirmDelete(d, 'the watchlist “Majors”')).toBe(true);
    expect(d.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete the watchlist “Majors”?', confirmLabel: 'Delete', tone: 'danger' }),
    );
    expect(await confirmDelete(dialogs(null), 'x')).toBe(false);
  });
});

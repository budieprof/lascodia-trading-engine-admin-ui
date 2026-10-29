import type { AssistantWriteGuard } from './assistant-write-guard';
import { describeBlocked } from './assistant-write-guard';
import {
  clickRefusal,
  currentValue,
  fieldKind,
  fieldLabel,
  fieldRefusal,
  findClickTarget,
  findField,
  findWithin,
  listControls,
  openOverlays,
  overlayTitle,
  pressEnter,
  setFieldValue,
} from './page-controls';
import type { UiCommand } from './ui-command.types';

/**
 * The commands that let the assistant change what ANY page displays: `page.listControls`,
 * `page.setField`, `page.click`. Registered globally by the dock next to `page.read`.
 *
 * <p>Each driving command runs inside {@link AssistantWriteGuard#run}: a request that is not a read
 * is refused in the browser, and the result says so, so the model proposes the change through the
 * engine (an approval card) instead.</p>
 */
export function pageControlCommands(
  guard: AssistantWriteGuard,
  location: () => string = () => window.location.pathname + window.location.search,
  doc: () => Document = () => document,
): UiCommand[] {
  const SAFETY =
    'These only change what the page DISPLAYS. They can never change data: any control that would ' +
    'save, send or change something is refused, and any write it tries is blocked. To change data, ' +
    'propose the engine operation (it becomes an approval card the operator clicks).';

  return [
    {
      id: 'page.listControls',
      description:
        "List the current page's view controls: its fields (filters, search boxes, selects, date " +
        'ranges, checkboxes — label, kind, current value, options) and clickable view controls ' +
        '(expanders, sortable column headers, pagination, "show more", links, view buttons), plus which ' +
        'tables have rows that open a detail. Use the labels exactly as listed with page.setField and ' +
        'page.click. Tabs are in page.read (use page.selectTab). ' +
        SAFETY,
      run: () => {
        const r = listControls(doc());
        return {
          ok: true,
          message:
            `${r.fields.length} field(s), ${r.controls.length} control(s), ` +
            `${r.rows.length} table(s) with rows` +
            (r.actionsNotClickable.length
              ? `; ${r.actionsNotClickable.length} action button(s) not clickable (they change data).`
              : '.'),
          data: r,
        };
      },
    },
    {
      id: 'page.setField',
      description:
        'Set a field on the current page by its label (as page.listControls lists it): type into a ' +
        'search box or filter, pick a select option (by its text), tick/untick a checkbox (true/false), ' +
        'choose a radio option, or set a date (YYYY-MM-DD). Set submit=true to press Enter after typing ' +
        "(search boxes that wait for Enter). Reports the field's value afterwards and whether the page " +
        're-queried. Never use it to fill in a form that creates or changes something. ' +
        SAFETY,
      params: [
        {
          name: 'label',
          type: 'string',
          required: true,
          description: 'The field label, e.g. "Symbol" or "Search within table".',
        },
        {
          name: 'value',
          type: 'string',
          description:
            'The value: text, an option label, true/false, or a date. Empty clears the field.',
        },
        {
          name: 'submit',
          type: 'boolean',
          description: 'Press Enter after setting it (default false).',
        },
        {
          name: 'within',
          type: 'string',
          description: 'Only look inside the section, card or dialog whose text contains this.',
        },
      ],
      run: async (args) => {
        const d = doc();
        const label = String(args['label'] ?? '').trim();
        const within = typeof args['within'] === 'string' ? args['within'] : '';
        const scope = within ? findWithin(d, within) : null;
        if (within && !scope)
          return { ok: false, message: `Nothing on the page contains "${within}".` };
        const el = findField(d, label, scope);
        if (!el) {
          const known = listControls(d).fields.map((f) => f.label);
          return {
            ok: false,
            message: known.length
              ? `No field "${label}". Fields here: ${known.join(', ')}.`
              : 'This page has no fields.',
          };
        }
        const refusal = fieldRefusal(el);
        if (refusal) return { ok: false, message: `Not set: ${refusal}.` };
        const name = fieldLabel(el) || label;

        const report = await guard.run(() => {
          const outcome = setFieldValue(el, args['value']);
          if (outcome.ok && args['submit'] === true) pressEnter(el);
          return outcome;
        });
        const outcome = report.value;
        const after = el.isConnected ? currentValue(el) : outcome.value;
        const msg = outcome.ok
          ? `Set "${name}" (${fieldKind(el)}) to ${JSON.stringify(after)}` +
            (args['submit'] === true ? ' and pressed Enter' : '') +
            (report.requests.length
              ? `; the page re-queried (${report.requests.length} request(s)).`
              : '; the page made no new requests.')
          : `Could not set "${name}": ${outcome.problem}.`;
        return {
          ok: outcome.ok && report.blocked.length === 0,
          message: msg + describeBlocked(report),
          data: {
            field: name,
            value: after,
            requests: report.requests,
            blocked: report.blocked,
            ...(report.blockedEarlier.length ? { blockedEarlier: report.blockedEarlier } : {}),
          },
        };
      },
    },
    {
      id: 'page.click',
      description:
        'Click a VIEW control on the current page by its label (as page.listControls lists it): expand ' +
        'a section or row, sort by a column header, go to the next page, "show more", open a link, or ' +
        "open a table row's detail. Use `within` to pick the row or section whose text contains it " +
        '(e.g. label "Details", within "EURUSD"); give only `within` to open that row itself. Reports ' +
        'what changed: the new address, a dialog or drawer that opened, the requests the page made. ' +
        'Buttons that act (save, run, pause, approve, buy, delete …) and form submit buttons are refused. ' +
        SAFETY,
      params: [
        {
          name: 'label',
          type: 'string',
          description:
            'The control label, e.g. "Next page", "Show more", "Symbol" (a column header).',
        },
        {
          name: 'within',
          type: 'string',
          description:
            'Text identifying the table row or section to act in, e.g. "EURUSD" or an id.',
        },
      ],
      run: async (args) => {
        const d = doc();
        const label = typeof args['label'] === 'string' ? args['label'].trim() : '';
        const within = typeof args['within'] === 'string' ? args['within'].trim() : '';
        if (!label && !within) return { ok: false, message: 'Give a label, a within, or both.' };
        const scope = within ? findWithin(d, within) : null;
        if (within && !scope)
          return { ok: false, message: `No row or section on the page contains "${within}".` };
        const target = findClickTarget(d, label || null, scope);
        if (!target) {
          return {
            ok: false,
            message: label
              ? `No control "${label}"${within ? ` in the part containing "${within}"` : ''}. Call page.listControls for what is clickable.`
              : `"${within}" matched a section, not a row — say which control to click in it.`,
          };
        }
        // A row's own text is data, not a control label — only its link (if any) is checked.
        const refusal =
          target.kind === 'row'
            ? target.el.tagName === 'A'
              ? clickRefusal(target.el, 'the row link', d)
              : null
            : clickRefusal(target.el, target.label, d);
        if (refusal) return { ok: false, message: `Not clicked: ${refusal}. ${SAFETY}` };

        const urlBefore = location();
        const overlaysBefore = new Set(openOverlays(d));
        const expandedBefore = target.el.getAttribute('aria-expanded');
        const report = await guard.run(() => target.el.click());
        const urlAfter = location();
        const opened = openOverlays(d).filter((o) => !overlaysBefore.has(o));
        const changes: string[] = [];
        if (urlAfter !== urlBefore) changes.push(`the page moved to ${urlAfter}`);
        if (opened.length) changes.push(`opened ${opened.map(overlayTitle).join(', ')}`);
        const expandedAfter = target.el.isConnected
          ? target.el.getAttribute('aria-expanded')
          : null;
        if (target.kind === 'sort') {
          const sortAfter = sortState(target.el, d);
          if (sortAfter) changes.push(`the column is now sorted ${sortAfter}`);
        }
        if (expandedBefore !== null && expandedAfter !== null && expandedAfter !== expandedBefore)
          changes.push(expandedAfter === 'true' ? 'it expanded' : 'it collapsed');
        if (report.requests.length)
          changes.push(`the page made ${report.requests.length} request(s)`);
        const what = target.kind === 'row' ? `the row "${target.label}"` : `"${target.label}"`;
        return {
          ok: report.blocked.length === 0,
          message:
            `Clicked ${what}: ${changes.length ? changes.join('; ') : 'no visible change detected — use page.read to check'}.` +
            describeBlocked(report),
          data: {
            clicked: target.label,
            kind: target.kind,
            url: urlAfter,
            ...(opened.length ? { opened: opened.map(overlayTitle) } : {}),
            requests: report.requests,
            blocked: report.blocked,
            ...(report.blockedEarlier.length ? { blockedEarlier: report.blockedEarlier } : {}),
          },
        };
      },
    },
  ];
}

/**
 * A sort header's state after a click. Grids re-render headers, so the clicked element may be gone:
 * look the column up again by its label.
 */
function sortState(el: HTMLElement, doc: Document): string | null {
  const read = (h: Element | null) => {
    const v = h?.getAttribute('aria-sort');
    return v && v !== 'none' ? v : null;
  };
  if (el.isConnected) return read(el.closest('[aria-sort]'));
  const label = (el.innerText || el.textContent || '').trim();
  const again = [...doc.querySelectorAll('[aria-sort]')].find(
    (h) => ((h as HTMLElement).innerText || h.textContent || '').trim() === label,
  );
  return read(again ?? null);
}

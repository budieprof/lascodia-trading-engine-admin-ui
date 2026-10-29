import { describe, expect, it } from 'vitest';
import { findTab, readPage } from './page-reader';

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.replaceChildren(root);
  return root;
}

const SAMPLE = `
  <h1>Instrument candles</h1>
  <app-feature-state>
    <section class="fs" data-kind="partial" role="status">
      <header class="head"><span class="pill">On · needs setup</span><h3 class="title">Candle builder</h3>
        <code class="key">MarketData:InstrumentCandles:Enabled</code></header>
      <p class="summary">Builds candles from exchange prints.</p>
      <ul class="reqs">
        <li data-ok="true"><span class="req-label">Crypto feed running</span><span class="req-detail">3 exchanges</span></li>
        <li data-ok="false"><span class="req-label">Databento key</span><span class="req-detail">not set</span></li>
      </ul>
    </section>
  </app-feature-state>
  <app-metric-card><div class="metric-card"><span class="metric-label">Symbols</span><div class="metric-value">5</div></div></app-metric-card>
  <div class="tabs"><button class="active">Overview</button><button>Roll calendar</button></div>
  <section><h2>Recent bars</h2>
    <table><thead><tr><th>Symbol</th><th>Close</th></tr></thead>
      <tbody><tr><td>BTCUSD</td><td>67,000</td></tr><tr><td>ETHUSD</td><td>3,100</td></tr></tbody></table>
  </section>
  <section><h2>Roll calendar</h2><p class="empty-state">No rolls due this week</p></section>
`;

describe('readPage', () => {
  it('reads title, status cards, figures, tabs, tables and notices', () => {
    const r = readPage(page(SAMPLE));
    expect(r.title).toBe('Instrument candles');
    expect(r.featureStates[0]).toMatchObject({
      state: 'On · needs setup',
      title: 'Candle builder',
      switchKey: 'MarketData:InstrumentCandles:Enabled',
    });
    expect(r.featureStates[0].needs).toEqual([
      { label: 'Crypto feed running', ok: true, detail: '3 exchanges' },
      { label: 'Databento key', ok: false, detail: 'not set' },
    ]);
    expect(r.figures).toContainEqual({ label: 'Symbols', value: '5' });
    expect(r.tabs).toEqual([
      { label: 'Overview', active: true },
      { label: 'Roll calendar', active: false },
    ]);
    expect(r.tables[0]).toMatchObject({
      heading: 'Recent bars',
      columns: ['Symbol', 'Close'],
      renderedRows: 2,
      rows: [
        ['BTCUSD', '67,000'],
        ['ETHUSD', '3,100'],
      ],
    });
    expect(r.notices).toContain('No rolls due this week');
  });

  it('limits rows and narrows to one section', () => {
    const r = readPage(page(SAMPLE), { section: 'Recent bars', rows: 1 });
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0].rows).toEqual([['BTCUSD', '67,000']]);
    expect(r.notices).toEqual([]);
  });

  it('says when a section was not found and reads the whole page', () => {
    const r = readPage(page(SAMPLE), { section: 'Nope' });
    expect(r.sectionNotFound).toBe('Nope');
    expect(r.tables).toHaveLength(1);
  });
});

describe('findTab', () => {
  it('matches exact, then prefix, then contains — case-insensitive', () => {
    const root = page(SAMPLE);
    expect(findTab(root, 'roll calendar')?.textContent).toBe('Roll calendar');
    expect(findTab(root, 'roll')?.textContent).toBe('Roll calendar');
    expect(findTab(root, 'missing')).toBeNull();
  });
});

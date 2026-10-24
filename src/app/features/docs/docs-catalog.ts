/**
 * The documentation portal's guides (`/docs`). Each is a Markdown file under `public/docs-content/` shipped with
 * the console release; the API reference is generated from the engine's OpenAPI document
 * (`public/docs-content/api-reference.json`, copied from the engine by `npm run docs:api`).
 */
export interface DocGuide {
  slug: string;
  title: string;
  summary: string;
  /** Who it is for. */
  audience: 'Everyone' | 'Administrators' | 'Platform staff' | 'Developers';
}

export const DOC_GUIDES: readonly DocGuide[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    summary:
      'From a new organisation to its first live chart: sign-up, the first Owner, a terminal, the chart.',
    audience: 'Everyone',
  },
  {
    slug: 'user-guide',
    title: 'User guide',
    summary:
      'Charts, the order book ladder, bar replay, alerts, scripts — and what each number means.',
    audience: 'Everyone',
  },
  {
    slug: 'ea-install',
    title: 'EA install guide',
    summary:
      'Install the Lascodia EA in MetaTrader 5, connect it with an enrollment token, fix what goes wrong.',
    audience: 'Administrators',
  },
  {
    slug: 'admin-guide',
    title: 'Administrator guide',
    summary:
      'Members and roles, security policy, terminals, risk and kill switches, settings, alerts, plans, export and closing.',
    audience: 'Administrators',
  },
  {
    slug: 'fund-guide',
    title: 'Fund module guide',
    summary:
      'Four-eyes approval policies, performance statements and investors, best-execution evidence, compliance exports.',
    audience: 'Administrators',
  },
  {
    slug: 'platform-guide',
    title: 'Platform operator guide',
    summary:
      'Organisations and sign-ups, market-data sources and entitlements, the public demo, fleet health.',
    audience: 'Platform staff',
  },
  {
    slug: 'integrations',
    title: 'Integration guides',
    summary:
      'CME futures depth (Databento / Rithmic), FIX market-data venues, alert webhooks, API tokens.',
    audience: 'Platform staff',
  },
  {
    slug: 'api-overview',
    title: 'API overview',
    summary:
      'Base URL, sign-in, the response envelope and codes, permissions, rate limits — then the full reference.',
    audience: 'Developers',
  },
];

export function guideBySlug(slug: string | null | undefined): DocGuide | null {
  return DOC_GUIDES.find((g) => g.slug === slug) ?? null;
}

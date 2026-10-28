/**
 * The documentation portal's guides (`/docs`). Each is a Markdown file under `public/docs-content/` shipped with
 * the console release (syntax in markdown.ts; screenshots under `public/docs-content/img/`, captured by
 * `npm run docs:shots`); the API reference is generated from the engine's OpenAPI document
 * (`public/docs-content/api-reference.json`, copied from the engine by `npm run docs:api`).
 */
import type { DocIconName } from './docs-icons';

export type DocAudience = 'Everyone' | 'Administrators' | 'Platform staff' | 'Developers';

export interface DocGuide {
  slug: string;
  title: string;
  summary: string;
  /** Who it is for. */
  audience: DocAudience;
  icon: DocIconName;
  /** When the guide was last revised (ISO date). */
  updated: string;
}

export interface DocGroup {
  audience: DocAudience;
  title: string;
  blurb: string;
  icon: DocIconName;
}

export const DOC_GROUPS: readonly DocGroup[] = [
  {
    audience: 'Everyone',
    title: 'Using Lascodia',
    blurb: 'For everyone: charts, placing trades and what the words mean.',
    icon: 'chart-candlestick',
  },
  {
    audience: 'Administrators',
    title: 'Running your organisation',
    blurb: 'For owners and admins: people, terminals, brokers and exchanges, safety.',
    icon: 'building',
  },
  {
    audience: 'Platform staff',
    title: 'Running the platform',
    blurb: 'For platform staff: organisations, data sources and switching on new markets.',
    icon: 'server',
  },
  {
    audience: 'Developers',
    title: 'Building on Lascodia',
    blurb: 'For developers: signing in from code, the response format and every endpoint.',
    icon: 'braces',
  },
];

export const DOC_GUIDES: readonly DocGuide[] = [
  {
    slug: 'getting-started',
    title: 'Start here',
    summary: 'Five steps from a brand-new organisation to your first live chart.',
    audience: 'Everyone',
    icon: 'rocket',
    updated: '2026-10-28',
  },
  {
    slug: 'user-guide',
    title: 'Using the chart',
    summary: 'Prices, the order book, alerts, replay and scripts, explained with pictures.',
    audience: 'Everyone',
    icon: 'chart-candlestick',
    updated: '2026-10-28',
  },
  {
    slug: 'trading-guide',
    title: 'Placing trades',
    summary:
      'Buy and sell forex, futures, crypto and stocks: practise on paper first, then go live.',
    audience: 'Everyone',
    icon: 'shopping-cart',
    updated: '2026-10-28',
  },
  {
    slug: 'glossary',
    title: 'Words explained',
    summary: 'Every trading and console word in this help, in one plain sentence each.',
    audience: 'Everyone',
    icon: 'book-open',
    updated: '2026-10-28',
  },
  {
    slug: 'ea-install',
    title: 'Connect MetaTrader 5',
    summary: 'Install the Lascodia EA, connect it in a few clicks, and fix what goes wrong.',
    audience: 'Administrators',
    icon: 'plug',
    updated: '2026-10-28',
  },
  {
    slug: 'admin-guide',
    title: 'Running your organisation',
    summary:
      'People and roles, sign-in security, terminals, safety switches, alerts, plans and billing.',
    audience: 'Administrators',
    icon: 'building',
    updated: '2026-10-28',
  },
  {
    slug: 'connections-guide',
    title: 'Connect a broker or exchange',
    summary:
      'Add a futures broker, crypto exchange or stock broker, store its keys safely, and test it.',
    audience: 'Administrators',
    icon: 'cable',
    updated: '2026-10-28',
  },
  {
    slug: 'fund-guide',
    title: 'Funds and investors',
    summary:
      'Two-person approvals, investor statements, best-execution evidence and compliance exports.',
    audience: 'Administrators',
    icon: 'landmark',
    updated: '2026-10-28',
  },
  {
    slug: 'platform-guide',
    title: 'Platform operator guide',
    summary:
      'Organisations, plans and billing, data sources and licences, staff access, fleet health.',
    audience: 'Platform staff',
    icon: 'server',
    updated: '2026-10-28',
  },
  {
    slug: 'multi-asset-setup',
    title: 'Switching on futures, crypto and stocks',
    summary: 'Margins, fees, symbol matching, the on/off switches and a safe step-by-step rollout.',
    audience: 'Platform staff',
    icon: 'layers',
    updated: '2026-10-28',
  },
  {
    slug: 'integrations',
    title: 'Data feeds and integrations',
    summary: 'CME futures depth, FIX market-data venues, alert webhooks and API tokens.',
    audience: 'Platform staff',
    icon: 'satellite',
    updated: '2026-10-28',
  },
  {
    slug: 'api-overview',
    title: 'API overview',
    summary: 'The address, signing in, the response format and codes, permissions and rate limits.',
    audience: 'Developers',
    icon: 'braces',
    updated: '2026-10-28',
  },
];

export function guideBySlug(slug: string | null | undefined): DocGuide | null {
  return DOC_GUIDES.find((g) => g.slug === slug) ?? null;
}

/** The guides either side of one, in catalog order (for "previous / next" at the end of a guide). */
export function neighbours(slug: string): { prev: DocGuide | null; next: DocGuide | null } {
  const i = DOC_GUIDES.findIndex((g) => g.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: DOC_GUIDES[i - 1] ?? null, next: DOC_GUIDES[i + 1] ?? null };
}

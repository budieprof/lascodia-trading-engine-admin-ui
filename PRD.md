# Product Requirements Document

# Lascodia Trading Engine — Admin UI

**Version:** 1.0
**Date:** 2026-03-21
**Status:** Draft

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Tech Stack](#3-tech-stack)
   - 3.1 [Design Language — Apple-Inspired Premium UI](#31-design-language--apple-inspired-premium-ui)
4. [Architecture](#4-architecture)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [API Integration Layer](#6-api-integration-layer)
7. [Feature Modules](#7-feature-modules)
   - 7.1 [Dashboard](#71-dashboard)
   - 7.2 [Orders Management](#72-orders-management)
   - 7.3 [Positions Management](#73-positions-management)
   - 7.4 [Strategies Management](#74-strategies-management)
   - 7.5 [Trade Signals](#75-trade-signals)
   - 7.6 [Trading Accounts](#76-trading-accounts)
   - 7.7 [Broker Management](#77-broker-management)
   - 7.8 [Risk Profiles](#78-risk-profiles)
   - 7.9 [Currency Pairs](#79-currency-pairs)
   - 7.10 [Market Data](#710-market-data)
   - 7.11 [ML Models & Training](#711-ml-models--training)
   - 7.12 [Backtesting & Walk-Forward](#712-backtesting--walk-forward)
   - 7.13 [Strategy Ensemble & Allocation](#713-strategy-ensemble--allocation)
   - 7.14 [Alerts](#714-alerts)
   - 7.15 [Execution Quality](#715-execution-quality)
   - 7.16 [Sentiment & Market Regime](#716-sentiment--market-regime)
   - 7.17 [Performance Attribution](#717-performance-attribution)
   - 7.18 [Drawdown Recovery](#718-drawdown-recovery)
   - 7.19 [Paper Trading](#719-paper-trading)
   - 7.20 [Engine Configuration](#720-engine-configuration)
   - 7.21 [Audit Trail](#721-audit-trail)
   - 7.22 [System Health](#722-system-health)
8. [Shared UI Components](#8-shared-ui-components)
9. [Navigation & Layout](#9-navigation--layout)
10. [Data Patterns](#10-data-patterns)
11. [Charts & Visualization](#11-charts--visualization)
12. [Error Handling & Notifications](#12-error-handling--notifications)
13. [Implementation Phases](#13-implementation-phases)
14. [Non-Functional Requirements](#14-non-functional-requirements)

---

## 1. Overview

The Lascodia Trading Engine Admin UI is a **single-page web application** that provides a comprehensive management interface for the Lascodia Automated Forex Trading Engine backend. It allows operators to monitor live trading activity, manage strategies, configure risk parameters, oversee ML model lifecycle, review backtests, and control all aspects of the engine through a modern, responsive dashboard.

The backend exposes 30+ REST API controllers with 100+ endpoints covering core trading, risk management, ML operations, backtesting, market data, and system configuration. The Admin UI surfaces all of these capabilities in an intuitive, real-time interface.

### Core Value Proposition

- **Unified control plane** — single interface to manage all engine subsystems
- **Real-time monitoring** — live P&L, open positions, order status, system health
- **Actionable operations** — approve/reject signals, activate strategies, trigger training, switch brokers
- **Visual analytics** — equity curves, performance attribution charts, drawdown tracking, regime detection
- **Risk visibility** — drawdown gauges, exposure heatmaps, execution quality metrics
- **ML lifecycle management** — model training, shadow evaluation, champion/challenger promotion

---

## 2. Goals & Non-Goals

### Goals

- [ ] Provide real-time visibility into all trading operations (orders, positions, P&L)
- [ ] Enable full CRUD management of strategies, brokers, accounts, risk profiles, and currency pairs
- [ ] Support trade signal approval/rejection workflows
- [ ] Visualize performance metrics with interactive charts (equity curves, drawdown, attribution)
- [ ] Manage the ML model lifecycle (train, evaluate, promote, rollback)
- [ ] Monitor system health, broker connectivity, and execution quality
- [ ] Configure engine parameters via hot-reload config UI
- [ ] Provide searchable, filterable audit trail of all engine decisions
- [ ] Support paper trading mode toggle and monitoring
- [ ] Responsive layout for desktop and tablet usage

### Non-Goals

- Mobile-native app (responsive web is sufficient)
- Direct broker API integration (all operations go through the backend)
- User management / multi-tenancy (single-operator admin tool)
- Real-time price charting with technical indicators (use Grafana/TradingView for that)
- Automated alerting configuration in the UI (alerts are managed but notifications go through backend channels)

---

## 3. Tech Stack

| Layer            | Technology                             | Rationale                                                                                    |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Framework        | **Angular 19**                         | Enterprise-grade framework with batteries-included DI, routing, forms, and HTTP client       |
| Language         | **TypeScript 5**                       | Type safety across API contracts (first-class in Angular)                                    |
| Build Tool       | **Angular CLI / esbuild**              | Official toolchain with fast builds and HMR via `ng serve`                                   |
| Routing          | **Angular Router**                     | Built-in lazy-loaded routing with guards and resolvers                                       |
| State Management | **Angular Signals + RxJS**             | Fine-grained reactivity with signals; RxJS for async streams and polling                     |
| UI Components    | **Custom component library**           | Bespoke Apple-inspired design system — no off-the-shelf Material/Bootstrap                   |
| Styling          | **Tailwind CSS 4 + SCSS**              | Utility-first with SCSS for complex animations, glassmorphism, and design tokens             |
| Forms            | **Angular Reactive Forms**             | Built-in typed reactive forms with validators                                                |
| Tables           | **AG Grid Community**                  | Enterprise-grade data grid with virtual scrolling, server-side row model, and column pinning |
| Charts           | **Apache ECharts (ngx-echarts)**       | Premium-quality, GPU-accelerated charts with rich animations and interactions                |
| HTTP Client      | **Angular HttpClient**                 | Built-in with interceptors for auth, error handling, and response transformation             |
| Date Handling    | **date-fns**                           | Lightweight, tree-shakeable date utilities                                                   |
| Icons            | **Lucide Icons (lucide-angular)**      | Clean, minimal stroke icons matching Apple aesthetic                                         |
| Animations       | **Angular Animations + CSS**           | Fluid micro-interactions, page transitions, and state changes                                |
| Notifications    | **Custom toast component**             | Slide-in notification toasts with blur backdrop, matching Apple HIG                          |
| Fonts            | **SF Pro Display / Inter**             | SF Pro for macOS users, Inter as cross-platform fallback                                     |
| Testing          | **Vitest + Angular Testing Library**   | Fast unit and component tests                                                                |
| E2E Testing      | **Playwright**                         | Cross-browser end-to-end tests                                                               |
| Linting          | **ESLint (angular-eslint) + Prettier** | Code quality and formatting with Angular-specific rules                                      |

---

## 3.1 Design Language — Apple-Inspired Premium UI

The admin UI adopts a **luxurious, Apple Human Interface Guidelines (HIG)-inspired** design language. Every surface, interaction, and transition should feel premium, refined, and intentional — evoking the experience of using macOS system apps like Finder, System Settings, and Stocks.

### Design Principles

| Principle     | Description                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| **Clarity**   | Content is king. Generous whitespace, typographic hierarchy, and restrained color usage let data breathe |
| **Deference** | The UI recedes so the trading data is the hero. No decorative noise — every pixel earns its place        |
| **Depth**     | Layered surfaces with subtle shadows, translucency, and blur create spatial hierarchy                    |
| **Fluidity**  | Every state change is animated. Nothing snaps — everything eases, slides, or fades                       |
| **Precision** | Pixel-perfect alignment, consistent spacing scale, and optical balance across all views                  |

### Color System

#### Light Mode (Default)

| Token              | Value                             | Usage                                                     |
| ------------------ | --------------------------------- | --------------------------------------------------------- |
| `--bg-primary`     | `#FFFFFF`                         | Page background                                           |
| `--bg-secondary`   | `#F5F5F7`                         | Card backgrounds, sidebar                                 |
| `--bg-tertiary`    | `#E8E8ED`                         | Hover states, dividers                                    |
| `--bg-glass`       | `rgba(255, 255, 255, 0.72)`       | Glassmorphism panels (with `backdrop-filter: blur(20px)`) |
| `--text-primary`   | `#1D1D1F`                         | Headings, primary text                                    |
| `--text-secondary` | `#6E6E73`                         | Captions, labels, secondary info                          |
| `--text-tertiary`  | `#86868B`                         | Placeholders, disabled text                               |
| `--accent`         | `#0071E3`                         | Primary actions, links, active states                     |
| `--accent-hover`   | `#0077ED`                         | Hover on primary actions                                  |
| `--profit`         | `#34C759`                         | Positive P&L, success states                              |
| `--loss`           | `#FF3B30`                         | Negative P&L, error states                                |
| `--warning`        | `#FF9500`                         | Warnings, paper trading indicator                         |
| `--border`         | `rgba(0, 0, 0, 0.06)`             | Card borders, dividers                                    |
| `--shadow-sm`      | `0 1px 3px rgba(0, 0, 0, 0.04)`   | Cards, inputs                                             |
| `--shadow-md`      | `0 4px 12px rgba(0, 0, 0, 0.08)`  | Dropdowns, modals                                         |
| `--shadow-lg`      | `0 12px 40px rgba(0, 0, 0, 0.12)` | Elevated panels, dialog overlays                          |

#### Dark Mode

| Token              | Value                           | Usage                     |
| ------------------ | ------------------------------- | ------------------------- |
| `--bg-primary`     | `#000000`                       | Page background           |
| `--bg-secondary`   | `#1C1C1E`                       | Card backgrounds, sidebar |
| `--bg-tertiary`    | `#2C2C2E`                       | Hover states, dividers    |
| `--bg-glass`       | `rgba(28, 28, 30, 0.72)`        | Glassmorphism panels      |
| `--text-primary`   | `#F5F5F7`                       | Headings, primary text    |
| `--text-secondary` | `#A1A1A6`                       | Captions, labels          |
| `--text-tertiary`  | `#636366`                       | Placeholders, disabled    |
| `--accent`         | `#0A84FF`                       | Primary actions           |
| `--border`         | `rgba(255, 255, 255, 0.08)`     | Card borders              |
| `--shadow-sm`      | `0 1px 3px rgba(0, 0, 0, 0.3)`  | Cards                     |
| `--shadow-md`      | `0 4px 12px rgba(0, 0, 0, 0.4)` | Dropdowns                 |

### Typography

```scss
// Font stack — SF Pro for Apple devices, Inter as universal fallback
--font-family:
  'SF Pro Display', 'SF Pro Text', 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;

// Type scale (rem-based, 1rem = 16px)
--text-xs: 0.6875rem / 1rem; // 11px — micro labels, badges
--text-sm: 0.8125rem / 1.25rem; // 13px — table cells, captions
--text-base: 0.9375rem / 1.5rem; // 15px — body text, form inputs
--text-lg: 1.0625rem / 1.5rem; // 17px — card titles, section headers
--text-xl: 1.375rem / 1.75rem; // 22px — page titles
--text-2xl: 1.75rem / 2.125rem; // 28px — dashboard hero numbers
--text-3xl: 2.5rem / 2.75rem; // 40px — large metric displays

// Weights
--font-regular: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;

// Letter spacing — tighter for large text, normal for body
--tracking-tight: -0.022em; // headings
--tracking-normal: -0.01em; // body
```

### Spacing & Layout

```scss
// 4px base grid — all spacing is a multiple of 4px
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
--space-8: 32px;
--space-10: 40px;
--space-12: 48px;
--space-16: 64px;

// Content max-width
--content-max-width: 1440px;

// Card padding
--card-padding: 20px; // standard card
--card-padding-lg: 24px; // featured/hero cards

// Border radius — generous, Apple-style
--radius-sm: 8px; // buttons, inputs, badges
--radius-md: 12px; // cards, dropdowns
--radius-lg: 16px; // modals, panels
--radius-xl: 20px; // hero cards, featured sections
--radius-full: 9999px; // pills, avatars, toggles
```

### Component Design Specs

#### Cards

```
┌─────────────────────────────────────┐
│                                     │  Background: var(--bg-secondary)
│   Title                    Action   │  Border: 1px solid var(--border)
│   Subtitle / description            │  Border-radius: var(--radius-md)
│                                     │  Shadow: var(--shadow-sm)
│   ┌─────────────────────────────┐   │  Padding: var(--card-padding)
│   │       Content area          │   │
│   │                             │   │  Hover: shadow elevates to --shadow-md
│   └─────────────────────────────┘   │  Transition: all 0.2s ease
│                                     │
└─────────────────────────────────────┘
```

- No harsh borders — use `rgba` borders at 6-8% opacity
- Cards lift subtly on hover (`transform: translateY(-1px)`)
- Content sections separated by 1px `var(--border)` dividers, not heavy lines

#### Dashboard Metric Cards

```
┌───────────────────────────────┐
│  ○ Account Equity             │  Small colored dot + label (--text-secondary)
│                               │
│  $124,580.42                  │  Large number (--text-2xl, --font-semibold)
│  ↑ +2.34% today              │  Delta with directional arrow (--profit or --loss)
│                               │
│  ▁▂▃▄▅▆▇█▇▆▅▆▇ sparkline     │  Mini sparkline in accent/profit color
└───────────────────────────────┘
```

#### Buttons

| Variant         | Style                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Primary**     | `background: var(--accent)`, white text, `border-radius: var(--radius-full)`, padding `10px 20px`, subtle gradient overlay |
| **Secondary**   | `background: var(--bg-tertiary)`, dark text, same radius                                                                   |
| **Ghost**       | Transparent, text color only, hover shows `var(--bg-tertiary)`                                                             |
| **Destructive** | `background: var(--loss)`, white text                                                                                      |
| **Icon**        | 36x36px circle, ghost style, icon centered                                                                                 |

All buttons:

- `font-weight: 500`, `font-size: var(--text-sm)`
- Transition: `all 0.15s ease`
- Active state: `transform: scale(0.97)` — the Apple "press" feel
- Disabled: 40% opacity, no pointer events

#### Data Tables (AG Grid Themed)

- **Header row:** `var(--bg-tertiary)` background, `var(--text-secondary)` text, `font-weight: 600`, uppercase, `font-size: var(--text-xs)`, `letter-spacing: 0.04em`
- **Body rows:** White/transparent background, alternating row stripe at 2% opacity
- **Row hover:** Soft `var(--bg-secondary)` highlight with 0.15s transition
- **Selected row:** `var(--accent)` at 8% opacity background
- **Cell text:** `var(--text-sm)`, tabular-nums for numbers
- **Pagination:** Clean pill-style page buttons below table
- **No grid lines** — only subtle bottom borders on rows (`var(--border)`)

#### Inputs & Forms

- Height: `40px`
- Background: `var(--bg-primary)` (light) / `var(--bg-tertiary)` (dark)
- Border: `1px solid var(--border)`, `border-radius: var(--radius-sm)`
- Focus: `box-shadow: 0 0 0 3px rgba(0, 113, 227, 0.3)` (blue glow ring)
- Label: `var(--text-sm)`, `var(--text-secondary)`, positioned above input with `4px` gap
- Error: Red border + error text below in `var(--loss)` color

#### Dialogs / Modals

- Centered on screen, `max-width: 480px`
- `border-radius: var(--radius-lg)`
- Backdrop: `rgba(0, 0, 0, 0.4)` with `backdrop-filter: blur(8px)`
- Entry animation: fade in + scale from 0.96 to 1.0 (0.25s ease-out)
- Exit animation: fade out + scale to 0.96 (0.15s ease-in)
- Header: Title left, close button (X icon) right
- Actions: right-aligned, primary button on the right

#### Sidebar Navigation

- Width: `260px` collapsed icon-only at `72px`
- Background: `var(--bg-secondary)` with subtle glass effect in dark mode
- Nav items: `40px` height, `border-radius: var(--radius-sm)`, `var(--text-sm)`
- Active item: `var(--accent)` at 10% opacity background, `var(--accent)` text and icon
- Hover: `var(--bg-tertiary)` background
- Group labels: `var(--text-xs)`, `var(--text-tertiary)`, uppercase, `letter-spacing: 0.06em`
- Collapse/expand: smooth width animation (0.3s ease)
- Bottom: user avatar pill, theme toggle, collapse button

#### Status Badges

- Pill shape: `border-radius: var(--radius-full)`, padding `2px 10px`
- Font: `var(--text-xs)`, `font-weight: 600`
- Style: Soft background tint + matching text color (no harsh solid backgrounds)
  - Active/Filled/Approved: `#34C759` at 12% bg, `#248A3D` text
  - Pending/Submitted: `#FF9500` at 12% bg, `#C93400` text
  - Error/Rejected/Failed: `#FF3B30` at 12% bg, `#D70015` text
  - Inactive/Closed/Expired: `#8E8E93` at 12% bg, `#636366` text
  - Info/Connected: `#0071E3` at 12% bg, `#0040DD` text

#### Toast Notifications

- Position: top-right, stacked with 8px gap
- Width: `380px`
- Background: glassmorphism (`var(--bg-glass)`, `backdrop-filter: blur(20px)`)
- Border: `1px solid var(--border)`
- Shadow: `var(--shadow-md)`
- Entry: slide in from right + fade (0.3s ease-out)
- Exit: slide out to right + fade (0.2s ease-in)
- Auto-dismiss: 4 seconds with progress bar
- Left accent stripe: 3px colored bar (green/red/yellow/blue matching severity)

### Animations & Transitions

| Interaction             | Animation                                                |
| ----------------------- | -------------------------------------------------------- |
| Page navigation         | Fade + slide-up content (0.25s ease-out)                 |
| Card hover              | Shadow elevation + translateY(-1px), 0.2s ease           |
| Button press            | Scale to 0.97, 0.1s ease                                 |
| Modal open              | Backdrop fade + content scale from 0.96, 0.25s ease-out  |
| Modal close             | Reverse of open, 0.15s ease-in                           |
| Sidebar expand/collapse | Width animation, 0.3s cubic-bezier(0.4, 0, 0.2, 1)       |
| Tab switch              | Content cross-fade, 0.2s ease                            |
| Data loading            | Skeleton shimmer (gradient sweep), 1.5s infinite         |
| Status change           | Color cross-fade, 0.3s ease                              |
| Toast enter             | SlideInRight + fadeIn, 0.3s ease-out                     |
| Dropdown open           | Scale from 0.95 + fadeIn at origin point, 0.15s ease-out |
| Number change           | CountUp animation for metric cards, 0.6s ease-out        |

### Skeleton Loading

Skeleton screens match the exact layout of the content they replace:

- Soft rounded rectangles in `var(--bg-tertiary)`
- Shimmer gradient sweep animation: `linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent)` moving left-to-right over 1.5s
- No spinners — only skeleton placeholders for content areas
- Spinners used only for action buttons (small, 16px, inline)

### Responsive Breakpoints

| Breakpoint | Width     | Behavior                                               |
| ---------- | --------- | ------------------------------------------------------ |
| Desktop XL | >= 1440px | Full sidebar + wide content area                       |
| Desktop    | >= 1024px | Full sidebar + content                                 |
| Tablet     | >= 768px  | Collapsed icon sidebar + content                       |
| Mobile     | < 768px   | Hidden sidebar (hamburger toggle) + full-width content |

### Dark Mode

- Toggled via sidebar footer button or system preference (`prefers-color-scheme`)
- All colors defined as CSS custom properties — theme switch swaps the root variables
- Transition: `0.3s ease` on `background-color` and `color` for smooth theme switch
- Dark mode uses deeper blacks (#000000 background) matching Apple's true-black OLED aesthetic
- Glassmorphism effects are more prominent in dark mode

---

## 4. Architecture

### Project Structure

```
src/
├── app/
│   ├── core/                       # Singleton services, guards, interceptors
│   │   ├── auth/
│   │   │   ├── auth.service.ts
│   │   │   ├── auth.guard.ts
│   │   │   └── auth.interceptor.ts
│   │   ├── api/
│   │   │   ├── api.service.ts      # Base HttpClient wrapper, base URL config
│   │   │   └── api.types.ts        # ResponseData<T>, Pager<T>, PagerRequest
│   │   ├── services/               # One service per backend controller
│   │   │   ├── orders.service.ts
│   │   │   ├── positions.service.ts
│   │   │   ├── strategies.service.ts
│   │   │   ├── brokers.service.ts
│   │   │   ├── trading-accounts.service.ts
│   │   │   ├── risk-profiles.service.ts
│   │   │   ├── currency-pairs.service.ts
│   │   │   ├── trade-signals.service.ts
│   │   │   ├── market-data.service.ts
│   │   │   ├── ml-models.service.ts
│   │   │   ├── ml-evaluation.service.ts
│   │   │   ├── backtests.service.ts
│   │   │   ├── walk-forward.service.ts
│   │   │   ├── strategy-ensemble.service.ts
│   │   │   ├── alerts.service.ts
│   │   │   ├── execution-quality.service.ts
│   │   │   ├── sentiment.service.ts
│   │   │   ├── market-regime.service.ts
│   │   │   ├── performance.service.ts
│   │   │   ├── drawdown-recovery.service.ts
│   │   │   ├── paper-trading.service.ts
│   │   │   ├── config.service.ts
│   │   │   ├── audit-trail.service.ts
│   │   │   ├── trailing-stop.service.ts
│   │   │   ├── economic-events.service.ts
│   │   │   └── health.service.ts
│   │   └── notifications/
│   │       └── notification.service.ts
│   ├── shared/                     # Shared components, directives, pipes
│   │   ├── components/
│   │   │   ├── ui/                 # Design system primitives (button, input, card, badge, skeleton)
│   │   │   ├── data-table/         # AG Grid wrapper with Apple-themed styling
│   │   │   ├── status-badge/       # Pill-style color-coded status badges
│   │   │   ├── confirm-dialog/     # Glassmorphism confirmation modal
│   │   │   ├── detail-panel/       # Reusable detail view layout with tabs
│   │   │   ├── json-editor/        # Syntax-highlighted JSON editor
│   │   │   ├── toast/              # Custom glassmorphism toast notifications
│   │   │   ├── metric-card/        # Dashboard metric card with sparkline
│   │   │   └── page-header/        # Page header with breadcrumbs
│   │   ├── pipes/
│   │   │   ├── currency.pipe.ts
│   │   │   ├── relative-time.pipe.ts
│   │   │   └── pips.pipe.ts
│   │   ├── directives/
│   │   │   └── loading.directive.ts
│   │   └── shared.module.ts
│   ├── layout/                     # App shell components
│   │   ├── layout.component.ts     # Main layout with sidebar + content
│   │   ├── sidebar/
│   │   │   └── sidebar.component.ts
│   │   ├── header/
│   │   │   └── header.component.ts
│   │   └── breadcrumbs/
│   │       └── breadcrumbs.component.ts
│   ├── features/                   # Lazy-loaded feature modules
│   │   ├── dashboard/
│   │   ├── orders/
│   │   ├── positions/
│   │   ├── strategies/
│   │   ├── trade-signals/
│   │   ├── trading-accounts/
│   │   ├── brokers/
│   │   ├── risk-profiles/
│   │   ├── currency-pairs/
│   │   ├── market-data/
│   │   ├── ml-models/
│   │   ├── backtests/
│   │   ├── walk-forward/
│   │   ├── strategy-ensemble/
│   │   ├── alerts/
│   │   ├── execution-quality/
│   │   ├── sentiment/
│   │   ├── market-regime/
│   │   ├── performance/
│   │   ├── drawdown-recovery/
│   │   ├── paper-trading/
│   │   ├── engine-config/
│   │   ├── audit-trail/
│   │   └── system-health/
│   ├── app.component.ts
│   ├── app.config.ts               # provideRouter, provideHttpClient, etc.
│   └── app.routes.ts               # Top-level route definitions with lazy loading
├── environments/
│   ├── environment.ts
│   └── environment.prod.ts
├── styles.scss
└── main.ts
```

### Feature Module Structure

Each feature module follows a consistent internal structure using standalone components:

```
features/orders/
├── components/                     # Feature-specific components
│   ├── order-list/
│   │   └── order-list.component.ts
│   ├── order-detail/
│   │   └── order-detail.component.ts
│   ├── order-form/
│   │   └── order-form.component.ts
│   └── order-status-badge/
│       └── order-status-badge.component.ts
├── pages/                          # Route-level page components
│   ├── orders-page/
│   │   └── orders-page.component.ts
│   └── order-detail-page/
│       └── order-detail-page.component.ts
├── orders.routes.ts                # Feature route definitions
└── index.ts                        # Public exports
```

### Data Flow

```
User Action → Component → Service (HttpClient) → Backend API
                                                       ↓
UI Update ← Component (async pipe / signals) ← Observable / Signal ←┘
```

- **Server state** managed via Angular services returning `Observable<T>` from `HttpClient`
- **Signals** used for derived/reactive UI state within components
- **RxJS operators** (`switchMap`, `timer`, `shareReplay`) for polling, caching, and stream composition
- **Optimistic updates** for status changes (approve signal, activate strategy) via local signal mutation + API call
- **Polling** via `timer().pipe(switchMap(...))` for real-time-ish data (positions P&L, live prices, system health)

---

## 5. Authentication & Authorization

### JWT Token Flow

1. User enters credentials on login page
2. Frontend calls `POST /api/v1/lascodia-trading-engine/auth/token` (dev mode token generation)
3. JWT stored in memory via `AuthService` (injectable singleton) — **not** in localStorage to avoid XSS
4. `HttpInterceptor` attaches `Authorization: Bearer <token>` to every request
5. On 401 response, interceptor redirects to login page
6. Token expiry tracked client-side; prompt re-login before expiry

### AuthService

```typescript
@Injectable({ providedIn: 'root' })
export class AuthService {
  private tokenSignal = signal<string | null>(null);
  private userSignal = signal<AuthUser | null>(null);

  readonly token = this.tokenSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly isAuthenticated = computed(() => this.tokenSignal() !== null);

  login(credentials: LoginCredentials): Observable<void> { ... }
  logout(): void { ... }
}

interface AuthUser {
  passportId: string;
  firstName: string;
  lastName: string;
  email: string;
}
```

### Route Protection

All routes except `/login` are protected by a `canActivate` functional guard that checks `AuthService.isAuthenticated` and redirects unauthenticated users to `/login`.

---

## 6. API Integration Layer

### Base Configuration

```typescript
// core/api/api.service.ts
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly baseUrl = `${environment.apiBaseUrl}/api/v1/lascodia-trading-engine`;

  constructor(private http: HttpClient) {}
  // ... typed get/post/put/delete methods
}
```

### Response Contract

All backend responses follow this shape:

```typescript
interface ResponseData<T> {
  responseCode: string; // "00" = success, "-11" = validation, "-14" = not found
  responseMessage: string;
  data: T;
}

interface Pager<T> {
  items: T[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
  totalPages: number;
}

interface PagerRequest {
  pageNumber: number;
  pageSize: number;
  searchTerm?: string;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}
```

### Service Pattern

Each service is an injectable singleton extending the base `ApiService`:

```typescript
// core/services/orders.service.ts
@Injectable({ providedIn: 'root' })
export class OrdersService {
  constructor(private api: ApiService) {}

  getById(id: string): Observable<ResponseData<Order>> {
    return this.api.get<ResponseData<Order>>(`/order/${id}`);
  }
  list(params: PagerRequest): Observable<ResponseData<Pager<Order>>> {
    return this.api.post<ResponseData<Pager<Order>>>('/order/list', params);
  }
  create(data: CreateOrderRequest): Observable<ResponseData<Order>> {
    return this.api.post<ResponseData<Order>>('/order', data);
  }
  update(id: string, data: UpdateOrderRequest): Observable<ResponseData<Order>> {
    return this.api.put<ResponseData<Order>>(`/order/${id}`, data);
  }
  submit(id: string): Observable<ResponseData<void>> {
    return this.api.post<ResponseData<void>>(`/order/${id}/submit`);
  }
  cancel(id: string): Observable<ResponseData<void>> {
    return this.api.post<ResponseData<void>>(`/order/${id}/cancel`);
  }
  modify(id: string, data: ModifyOrderRequest): Observable<ResponseData<void>> {
    return this.api.put<ResponseData<void>>(`/order/${id}/modify`, data);
  }
  delete(id: string): Observable<ResponseData<void>> {
    return this.api.delete<ResponseData<void>>(`/order/${id}`);
  }
}
```

---

## 7. Feature Modules

### 7.1 Dashboard

The main landing page — a comprehensive command center providing real-time visibility across all engine subsystems.

**Layout:** Full-width hero metrics row → 2-column chart grid → activity feed + quick actions

#### Hero Metric Cards (Top Row — 5 cards, equal width)

| Card           | Data Source                              | Refresh | Visual                                                                     |
| -------------- | ---------------------------------------- | ------- | -------------------------------------------------------------------------- |
| Account Equity | `GET /trading-account/active/{brokerId}` | 15s     | Large number + delta % + 7-day sparkline                                   |
| Today's P&L    | Computed from positions                  | 15s     | Large number (green/red) + cumulative intraday area chart                  |
| Open Positions | `POST /position/list` (filtered)         | 15s     | Count + mini horizontal bar by symbol                                      |
| Drawdown       | `GET /drawdown-recovery/latest`          | 15s     | Gauge arc (0-100%) with threshold markers at warning/recovery/pause levels |
| System Health  | `GET /health/status`                     | 15s     | Radial status indicator (green/yellow/red) + subsystem count               |

#### Charts Grid (2x2 layout, each in a card)

| Chart                                 | Type                              | Description                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Equity Curve**                      | Gradient area chart               | Account balance over time (30d/90d/1y/all toggle). Gradient fill from accent blue to transparent. Crosshair + tooltip on hover showing exact balance + date. Overlaid dotted line for peak equity |
| **Daily P&L Waterfall**               | Bar chart with running total line | Vertical bars per day (green profit / red loss) for last 30 days. Thin overlay line showing cumulative P&L. Hover tooltip with day, P&L, cumulative, trade count                                  |
| **Strategy Allocation & Performance** | Donut chart + ranked list         | Inner donut showing capital allocation weights. Right side: ranked list of strategies with sparkline P&L, win rate, Sharpe — each row clickable to navigate to strategy detail                    |
| **Position Exposure Heatmap**         | Treemap                           | Rectangles sized by position notional value, colored by unrealized P&L (green gradient → red gradient). Hover shows symbol, lots, entry, current price, P&L                                       |

#### Live Activity & Status Row (Below charts)

| Panel                     | Content                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pending Signals Queue** | Scrollable list of pending signals with symbol, direction arrow, confidence bar, strategy name, time ago. Inline Approve/Reject buttons. Badge count in header. 15s poll    |
| **Recent Orders Feed**    | Live-scrolling feed of latest 20 orders — each row: status icon + symbol + side + lot + time ago. New entries animate in with slide-down                                    |
| **Engine Status Strip**   | Horizontal row of pill badges: Active Broker (name + health dot), Paper Trading (on/off toggle), Market Regime (latest), Active Models count, Worker Groups status (6 dots) |

#### Quick Actions Bar (Sticky bottom or floating)

- Approve All Pending Signals (with count badge)
- Toggle Paper Trading Mode
- Sync Account Balance
- Trigger Portfolio Rebalance

---

### 7.2 Orders Management

Full lifecycle management of trading orders.

**List View:**

- Paginated table with columns: ID, Symbol, Side (Buy/Sell), Type (Market/Limit/Stop), Lot Size, Price, Status, Strategy, Created At
- Filters: Status (Pending, Submitted, Filled, Cancelled, Rejected, Failed), Side, Symbol, Date Range
- Sort by any column
- Color-coded status badges

**Detail View:**

- Order metadata (all fields)
- Related position (if filled)
- Related strategy and signal
- Timeline of status changes

**Actions:**

- Create manual order (form with symbol, side, type, lot size, price, SL, TP)
- Submit pending order to broker
- Cancel pending/submitted order
- Modify SL/TP on active order
- Delete (soft-delete) order

**API Endpoints Used:**

- `POST /order` — create
- `PUT /order/{id}` — update
- `POST /order/{id}/submit` — submit to broker
- `POST /order/{id}/cancel` — cancel
- `PUT /order/{id}/modify` — modify SL/TP
- `DELETE /order/{id}` — soft delete
- `GET /order/{id}` — detail
- `POST /order/list` — paginated list

---

### 7.3 Positions Management

View and manage open and closed trading positions with comprehensive P&L monitoring.

**Tabs:** Open Positions | Closed Positions | Position Analytics

#### Open Positions Tab

**Summary Strip (top):**

- Total Unrealized P&L (large, green/red) + total lots + position count
- Exposure by currency donut (mini, inline)

**Live Table:**

- Columns: Symbol, Side (arrow icon), Entry Price, Current Price (live-updating with flash animation on change), Lot Size, Unrealized P&L (pips + currency, color-coded), SL/TP levels, Duration (relative time), Strategy
- Row background subtly tinted green/red based on P&L direction
- 10s poll for live price updates
- Inline row actions: Modify SL/TP, Scale In/Out, Close Position

#### Closed Positions Tab

- Paginated table with realized P&L, hold duration, entry/exit prices, R-multiple
- Filters: Symbol, Strategy, Date Range, P&L direction (winners/losers)

#### Position Analytics Panel (charts below table)

| Chart                       | Type                   | Description                                                                                       |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| **P&L Distribution**        | Histogram              | Distribution of realized P&L across all closed trades. Bell curve overlay. Bin width configurable |
| **Win/Loss by Symbol**      | Grouped horizontal bar | Green bar (wins) vs red bar (losses) per symbol. Shows which pairs are most profitable            |
| **Hold Duration vs P&L**    | Scatter plot           | Each closed trade as a dot: x-axis = duration, y-axis = P&L. Reveals optimal hold times           |
| **Cumulative P&L**          | Gradient area chart    | Running total of realized P&L over time. Drawdown periods shaded in red tint                      |
| **P&L by Session**          | Stacked bar            | London / New York / Tokyo / Sydney — which sessions generate the most profit                      |
| **R-Multiple Distribution** | Histogram              | Distribution of R-multiples (reward relative to risk). Vertical line at R=1                       |

**Detail View (slide-out panel):**

- Position header: Symbol + side + status badge + total P&L
- Price chart mini-view: Entry/exit markers on a simplified price line
- Orders tab: All associated orders (entry, scale, SL/TP modifications)
- Trailing stop configuration with type badge (Fixed / Percentage / ATR)

**API Endpoints Used:**

- `GET /position/{id}` — detail
- `POST /position/list` — paginated list
- `PUT /trailing-stop/{positionId}` — update trailing stop
- `POST /trailing-stop/scale` — scale position

---

### 7.4 Strategies Management

Configure, control, and deeply monitor trading strategies.

**Tabs:** Strategy List | Strategy Monitor | Optimization Lab

#### Strategy List Tab

- Paginated table: Name, Symbol, Timeframe, Type, Status (toggle switch inline), Win Rate (mini progress bar), Profit Factor, Sharpe, Risk Profile, Signals Today, Created At
- Filters: Status, Type, Symbol
- Each row expandable to show inline sparkline P&L chart (last 30 days) without navigating away
- Bulk actions: Activate All, Pause All (filtered selection)

#### Strategy Monitor Tab (comprehensive monitoring dashboard)

**Strategy Selector:** Dropdown or horizontal pill tabs to select one strategy (or "All Strategies" aggregate)

| Chart / Widget                     | Type                           | Description                                                                                                                                 |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Performance KPI Cards**          | 6 metric cards                 | Win Rate (gauge), Profit Factor (number + trend arrow), Sharpe Ratio, Max Drawdown %, Total Trades, Avg Trade P&L — each with 30d sparkline |
| **Equity Curve**                   | Gradient area chart            | Strategy-specific cumulative P&L over time. Toggle: 7d / 30d / 90d / All. Peak equity dotted overlay. Drawdown periods shaded red           |
| **Win Rate Over Time**             | Line chart                     | Rolling 20-trade win rate over time. Horizontal reference lines at 50% and the strategy's historical average                                |
| **Profit Factor Trend**            | Line chart with threshold band | Rolling profit factor. Green zone (>1.5), yellow zone (1.0-1.5), red zone (<1.0) background bands                                           |
| **Trade Outcome Heatmap**          | Calendar heatmap               | Day-of-week × hour-of-day grid, color intensity = P&L. Reveals optimal trading windows                                                      |
| **Signal Confidence Distribution** | Histogram                      | Distribution of confidence scores for signals generated. Overlaid with approval rate curve                                                  |
| **Drawdown Curve**                 | Inverted area chart            | Peak-to-trough drawdown over time. Red gradient fill. Markers at max drawdown points                                                        |
| **R-Multiple Scatter**             | Scatter plot                   | Each trade: x = trade number (chronological), y = R-multiple. Trendline overlay showing if strategy is improving or degrading               |
| **Monthly Returns Grid**           | Heatmap table                  | Rows = years, columns = months, cells colored by monthly return %. Total column on right                                                    |
| **Regime Performance**             | Grouped bar                    | Win rate + profit factor per market regime (Trending / Ranging / Volatile)                                                                  |
| **Risk Profile Compliance**        | Gauge set                      | Current lot size vs max, daily drawdown vs limit, open positions vs cap — each as a gauge                                                   |

#### Strategy Detail (full page)

- **Config Tab:** JSON editor with strategy parameters, risk profile dropdown, confidence threshold, signal expiry
- **Signals Tab:** Paginated list of trade signals from this strategy with approve/reject actions
- **Orders Tab:** All orders generated by this strategy
- **Optimization Tab:** History of optimization runs with approve/reject. Side-by-side parameter comparison (current vs proposed)

**Create/Edit Form:**

- Name, Symbol, Timeframe, Strategy Type (dropdown)
- Parameters (JSON editor with syntax highlighting)
- Risk Profile assignment (dropdown)
- Confidence threshold, signal expiry

**API Endpoints Used:**

- `POST /strategy` — create
- `PUT /strategy/{id}` — update
- `DELETE /strategy/{id}` — delete
- `PUT /strategy/{id}/activate` — activate
- `PUT /strategy/{id}/pause` — pause
- `PUT /strategy/{id}/risk-profile` — assign risk profile
- `GET /strategy/{id}` — detail
- `POST /strategy/list` — paginated list
- `GET /strategy-feedback/{strategyId}/performance` — performance snapshot
- `POST /strategy-feedback/optimization/trigger` — trigger optimization
- `PUT /strategy-feedback/optimization/{id}/approve` — approve optimization
- `PUT /strategy-feedback/optimization/{id}/reject` — reject optimization

---

### 7.5 Trade Signals

Review and act on signals generated by strategy evaluators.

**List View:**

- Paginated table: ID, Symbol, Direction, Confidence, Strategy, Status (Pending/Approved/Rejected/Expired), ML Score, Created At, Expires At
- Filters: Status, Symbol, Strategy, Confidence Range, Date Range
- **Pending signals highlighted** at the top

**Detail View:**

- Signal metadata
- ML prediction details (if scored)
- Source strategy info
- Resulting order (if approved and executed)

**Actions:**

- Approve signal (`PUT /trade-signal/{id}/approve`)
- Reject signal (`PUT /trade-signal/{id}/reject`)
- Expire signal (`PUT /trade-signal/{id}/expire`)
- Bulk approve/reject (checkbox selection)

**API Endpoints Used:**

- `PUT /trade-signal/{id}/approve`
- `PUT /trade-signal/{id}/reject`
- `PUT /trade-signal/{id}/expire`
- `GET /trade-signal/{id}`
- `POST /trade-signal/list`

---

### 7.6 Trading Accounts

Manage broker trading accounts.

**List View:**

- Paginated table: ID, Name, Broker, Balance, Equity, Margin, Status (Active/Inactive), Environment (Live/Practice)
- Filters: Status, Broker

**Detail View:**

- Account details (balance, equity, free margin, margin level)
- Linked broker info
- Recent orders and positions

**Create/Edit Form:**

- Account name, Broker (dropdown), Account Number, Environment
- Initial balance

**Actions:**

- Create, Update, Delete account
- Activate account
- Sync balance from broker (`PUT /trading-account/{id}/sync`)

**API Endpoints Used:**

- `POST /trading-account`
- `PUT /trading-account/{id}`
- `DELETE /trading-account/{id}`
- `PUT /trading-account/{id}/activate`
- `PUT /trading-account/{id}/sync`
- `GET /trading-account/{id}`
- `GET /trading-account/active/{brokerId}`
- `POST /trading-account/list`

---

### 7.7 Broker Management

Configure and monitor broker connections.

**List View:**

- Paginated table: ID, Name, Type, Status (Connected/Disconnected/Error), Environment, Is Active, Health
- Health indicator (green/yellow/red dot)

**Detail View:**

- Broker configuration
- Connection status
- API credentials (masked)
- Linked trading accounts
- Health check history

**Create/Edit Form:**

- Name, Broker Type, API Key (masked), API Secret (masked), Server URL
- Environment (Live/Practice)

**Actions:**

- Create, Update, Delete broker
- Activate broker
- Update broker status
- Switch active broker (`PUT /broker/switch`)
- Check health (`GET /broker/health`)

**API Endpoints Used:**

- `POST /broker`
- `PUT /broker/{id}`
- `DELETE /broker/{id}`
- `PUT /broker/{id}/activate`
- `PUT /broker/{id}/status`
- `PUT /broker/switch`
- `GET /broker/{id}`
- `GET /broker/active`
- `GET /broker/health`
- `POST /broker/list`

---

### 7.8 Risk Profiles

Define, manage, and monitor risk parameter compliance in real-time.

**Tabs:** Risk Profiles | Risk Monitor

#### Risk Profiles Tab

**List View:**

- Paginated table: ID, Name, Max Lot Size, Max Drawdown %, Max Daily Trades, Max Open Positions, Linked Strategies (count badge), Created At
- Each row expandable to show gauge summary of current compliance

**Create/Edit Form:**

- Name
- Max Lot Size, Min Lot Size
- Max Risk Per Trade (%)
- Max Daily Drawdown (%)
- Max Total Drawdown (%)
- Max Open Positions
- Max Daily Trades
- Max Symbol Exposure (%)

#### Risk Monitor Tab (comprehensive risk dashboard)

| Chart / Widget                 | Type                  | Description                                                                                                                                                                                                           |
| ------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Risk Compliance Gauges**     | Gauge row (6 gauges)  | Current utilization vs limits: Lot Size Used / Max, Daily Drawdown / Max, Total Drawdown / Max, Open Positions / Max, Daily Trades / Max, Symbol Exposure / Max. Green → yellow → red as utilization approaches limit |
| **Risk Utilization Over Time** | Multi-line chart      | Rolling utilization % for each risk metric over time. Threshold line at 100% (breach). Shows how close to limits the engine operates                                                                                  |
| **Position Size Distribution** | Histogram             | Distribution of lot sizes across all open and recent positions. Vertical lines at min/max limits                                                                                                                      |
| **Symbol Exposure Heatmap**    | Treemap               | Rectangles sized by exposure per symbol. Color = % of max allowed exposure. Red = near limit                                                                                                                          |
| **Daily Trades Counter**       | Bar chart + countdown | Bars = trades per day (last 30 days). Horizontal line at daily limit. Today's count prominently displayed                                                                                                             |
| **Margin Utilization**         | Area chart            | Used margin vs free margin over time. Alert zone shaded when margin utilization > 80%                                                                                                                                 |
| **Risk Events Log**            | Scrolling timeline    | Chronological feed of risk-related events: limit breaches, drawdown warnings, position rejections due to risk. Each event color-coded by severity                                                                     |
| **Correlation Risk Matrix**    | Heatmap grid          | Currency pair correlation matrix. Highly correlated open positions highlighted as concentration risk                                                                                                                  |

**Actions:**

- Create, Update, Delete risk profile
- View linked strategies

**API Endpoints Used:**

- `POST /risk-profile`
- `PUT /risk-profile/{id}`
- `DELETE /risk-profile/{id}`
- `GET /risk-profile/{id}`
- `POST /risk-profile/list`

---

### 7.9 Currency Pairs

Manage tradeable instrument metadata.

**List View:**

- Paginated table: ID, Symbol, Base Currency, Quote Currency, Pip Value, Contract Size, Min/Max Lot Size
- Search by symbol

**Create/Edit Form:**

- Symbol, Base Currency, Quote Currency
- Pip Value, Pip Size, Contract Size
- Min Lot Size, Max Lot Size, Lot Step

**Actions:**

- Create, Update, Delete currency pair

**API Endpoints Used:**

- `POST /currency-pair`
- `PUT /currency-pair/{id}`
- `DELETE /currency-pair/{id}`
- `GET /currency-pair/{id}`
- `POST /currency-pair/list`

---

### 7.10 Market Data

Live market data monitoring and historical candle analysis.

**Tabs:** Live Prices | Price Analytics | Candle History

#### Live Prices Tab

**Price Board:**

- Card grid (one card per watched symbol)
- Each card: Symbol name, Bid (left), Ask (right), Spread (center, highlighted if wide)
- Price digits flash green on uptick, red on downtick (animation)
- Mini sparkline (last 100 ticks) below bid/ask
- Daily high/low bar with current price marker
- Daily change % badge (green/red pill)
- Auto-refresh every 3 seconds

**Spread Monitor:**

- Horizontal bar chart of current spreads across all symbols. Sorted widest to narrowest. Threshold line at acceptable spread level

#### Price Analytics Tab

| Chart / Widget            | Type                    | Description                                                                                                              |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Intraday Price Lines**  | Multi-line chart        | All watched symbols normalized to % change from open. Shows relative movement. Toggle symbols on/off                     |
| **Volatility Comparison** | Bar chart               | Current ATR (Average True Range) per symbol. Sorted by volatility. Historical average overlay                            |
| **Spread Heatmap**        | Heatmap (hour × symbol) | Average spread by hour-of-day per symbol. Reveals when spreads are widest (low liquidity periods)                        |
| **Correlation Matrix**    | Heatmap grid            | Real-time price correlation between all pairs. Blue (negative) → white (none) → red (positive). Updated every 60 seconds |
| **Price Data Freshness**  | Horizontal bar          | Time since last price update per symbol. Red threshold at staleness limit. Reveals data feed issues                      |

#### Candle History Tab

- Paginated table: Symbol, Timeframe, Open, High, Low, Close, Volume, Timestamp
- Filters: Symbol, Timeframe, Date Range
- Each row expandable to show a mini candlestick visualization (last 20 candles in context)

**API Endpoints Used:**

- `GET /market-data/live-price/{symbol}`
- `GET /market-data/candle/latest`
- `POST /market-data/candle/list`

---

### 7.11 ML Models & Training

Full ML model lifecycle management with comprehensive model monitoring and evaluation dashboards.

**Tabs:** Model Registry | Model Monitor | Training Lab | Shadow Arena

#### Model Registry Tab

- Paginated table: Name, Symbol, Timeframe, Version, Status (Active/Inactive/Training badge), Overall Accuracy, Precision, Recall, Created At
- Filters: Status, Symbol, Timeframe
- Active model highlighted with accent glow per symbol/timeframe
- Each row expandable to show inline accuracy sparkline (last 30 days)
- Champion model pinned at top per symbol/timeframe group

#### Model Monitor Tab (comprehensive model health dashboard)

**Model Selector:** Dropdown to select active model (or compare two models side-by-side)

| Chart / Widget                         | Type                           | Description                                                                                                                                            |
| -------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Model KPI Cards**                    | 6 metric cards                 | Overall Accuracy (gauge 0-100%), Precision, Recall, F1 Score, Total Predictions, Avg Confidence — each with 30d sparkline                              |
| **Accuracy Over Time**                 | Multi-line chart               | Rolling accuracy (20-prediction window) over time. Horizontal threshold lines at 50% and target accuracy. Shaded confidence interval band              |
| **Accuracy by Market Regime**          | Grouped bar chart              | Accuracy + prediction count per regime (Trending / Ranging / Volatile). Reveals regime-dependent model quality                                         |
| **Accuracy by Trading Session**        | Grouped bar chart              | Accuracy per session (London / New York / Tokyo / Sydney). Each bar segmented by direction (Buy / Sell)                                                |
| **Accuracy by Time Horizon**           | Bar chart                      | Accuracy for each prediction horizon (1H, 4H, 1D, 1W). Shows whether model is better at short or long-term                                             |
| **Accuracy by Hour of Day**            | Heatmap (24 columns)           | Hour-of-day accuracy heatmap. Color intensity = accuracy %. Reveals optimal prediction hours                                                           |
| **Accuracy by Volatility Regime**      | Bar chart with scatter overlay | Bars = accuracy per volatility quintile. Scatter = prediction count. Shows if model degrades in high-vol                                               |
| **Confidence Calibration Curve**       | Line chart                     | X-axis = predicted confidence (bins), Y-axis = actual accuracy. Perfect calibration = diagonal line. Gap between actual and predicted = miscalibration |
| **Prediction Confidence Distribution** | Histogram                      | Distribution of confidence scores. Overlaid with outcome (correct in green, incorrect in red)                                                          |
| **Confusion Matrix**                   | Heatmap grid                   | 2x2 or 3x3 matrix (Buy/Sell/Hold predicted vs actual). Color intensity = count. Shows bias patterns                                                    |
| **EWMA Accuracy Drift**                | Line chart with drift bands    | Exponentially weighted moving average of accuracy. Alert bands at ±2σ. Drift detection markers (ADWIN changepoints)                                    |
| **Feature Staleness Monitor**          | Horizontal bar chart           | Each feature as a bar showing time since last update. Red threshold line at staleness limit. Stale features highlighted                                |
| **Prediction Outcome Timeline**        | Scatter strip                  | Chronological dots: green = correct, red = incorrect, size = confidence. Clusters of red indicate degradation periods                                  |
| **Kelly Fraction Trend**               | Area chart                     | Optimal Kelly fraction over time. Shows recommended position sizing based on model edge                                                                |
| **Model Version Comparison**           | Dual-axis line chart           | Overlay accuracy of current vs previous model version. Shaded region where current model outperforms                                                   |

#### Training Lab Tab

**Training Runs Table:**

- Paginated: ID, Model Name, Status (Running with progress bar / Completed / Failed), Duration, Train Accuracy, Val Accuracy, Test Accuracy, Loss, Started At
- Running trainings show animated progress indicator
- Completed runs show green checkmark; failed show red X with error tooltip

**Training Run Detail (expandable or slide-out):**

| Chart / Widget                    | Type                      | Description                                                                                            |
| --------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Loss Curve**                    | Dual-line chart           | Training loss vs validation loss over epochs. Divergence = overfitting indicator                       |
| **Accuracy Curve**                | Dual-line chart           | Training accuracy vs validation accuracy over epochs                                                   |
| **Learning Rate Schedule**        | Step chart                | Learning rate changes over training epochs                                                             |
| **Hyperparameter Summary**        | Key-value card grid       | All hyperparameters used in this run, side-by-side with previous best run                              |
| **Feature Importance**            | Horizontal bar chart      | Top 20 features ranked by importance. Color-coded by feature group (technical / sentiment / regime)    |
| **Hyperparameter Search Results** | Parallel coordinates plot | Each line = one trial. Axes = hyperparameters. Color = resulting accuracy. Visualizes the search space |

**Actions:**

- Trigger new training run (form: symbol, timeframe, parameters)
- Trigger hyperparameter search (form: search space config)
- Compare two training runs side-by-side

#### Shadow Arena Tab (Champion vs Challenger)

**Active Evaluations Table:**

- Challenger Model, Champion Model, Symbol, Start Date, Predictions So Far, Champion Accuracy, Challenger Accuracy, Status

**Shadow Evaluation Detail:**

| Chart / Widget                 | Type              | Description                                                                                       |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| **Head-to-Head Accuracy**      | Dual bar chart    | Side-by-side accuracy comparison over evaluation window                                           |
| **Cumulative Accuracy Race**   | Dual line chart   | Running accuracy of champion (blue) vs challenger (green) over time. Crossover points marked      |
| **Agreement Rate**             | Donut chart       | Percentage of predictions where both models agree vs disagree                                     |
| **Disagreement Analysis**      | Grouped bar       | When models disagree: who was right? Bars per outcome category                                    |
| **Confidence Comparison**      | Box plot pair     | Confidence distributions of champion vs challenger. Shows if challenger is more or less confident |
| **Regime-Specific Comparison** | Grouped bar chart | Accuracy of each model broken down by market regime. Reveals niche advantages                     |

**Actions:**

- Start new shadow evaluation (select challenger model)
- Promote challenger to champion (with confirmation dialog)
- End evaluation early

**API Endpoints Used:**

- `GET /ml-model/{id}`
- `POST /ml-model/list`
- `PUT /ml-model/{id}/activate`
- `POST /ml-model/rollback`
- `POST /ml-model/training/trigger`
- `POST /ml-model/training/hyperparam-search`
- `GET /ml-model/training/{id}`
- `POST /ml-model/training/list`
- `POST /ml-evaluation/shadow/start`
- `PUT /ml-evaluation/outcome`
- `GET /ml-evaluation/shadow/{id}`
- `POST /ml-evaluation/shadow/list`

---

### 7.12 Backtesting & Walk-Forward

Run and review historical strategy simulations with rich result visualization.

**Tabs:** Backtest Runs | Walk-Forward Runs | Results Comparison

#### Backtest Runs Tab

- Paginated table: ID, Strategy, Symbol, Timeframe, Status (Queued / Running with progress / Completed / Failed), Win Rate, Profit Factor, Max Drawdown, Sharpe, Date Range, Duration
- Filters: Strategy, Status, Symbol
- Running backtests show animated progress bar
- Queue new backtest run (form: strategy, symbol, timeframe, date range)

#### Walk-Forward Runs Tab

- Paginated table: ID, Strategy, Status, In-Sample / Out-of-Sample periods, OOS Win Rate, OOS Profit Factor, OOS Sharpe
- Queue new walk-forward run

#### Backtest / Walk-Forward Detail View (full page)

**KPI Summary Cards (top row):**

- Total Trades, Win Rate (gauge), Profit Factor, Sharpe Ratio, Max Drawdown %, Avg Trade P&L, Expectancy, Recovery Factor

**Charts Grid:**

| Chart                           | Type                     | Description                                                                                                               |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Equity Curve**                | Gradient area chart      | Cumulative P&L over the backtest period. Peak equity dotted overlay. Drawdown periods shaded red. Log/linear scale toggle |
| **Drawdown Curve**              | Inverted area chart      | Peak-to-trough drawdown below the equity curve. Deepest drawdown annotated                                                |
| **Monthly Returns Table**       | Heatmap grid             | Rows = years, columns = months, cells = return %. Color gradient green-to-red. Annual totals column                       |
| **Trade P&L Distribution**      | Histogram                | Distribution of individual trade P&L. Mean + median lines. Skewness indicator                                             |
| **Win/Loss Streak Chart**       | Bar chart                | Consecutive win streaks (green bars up) and loss streaks (red bars down) chronologically                                  |
| **Trade Duration Distribution** | Histogram                | How long trades are held. Separated by winners vs losers                                                                  |
| **P&L by Day of Week**          | Grouped bar              | Average P&L per day of week. Shows day-of-week effects                                                                    |
| **P&L by Hour**                 | Bar chart                | Average P&L per hour. Shows time-of-day effects                                                                           |
| **MAE / MFE Scatter**           | Scatter plot             | Maximum Adverse Excursion vs Maximum Favorable Excursion per trade. Reveals stop/target optimization opportunities        |
| **Walk-Forward OOS Equity**     | Multi-segment line chart | (Walk-forward only) In-sample periods in blue, out-of-sample in green. Shows whether OOS performance holds                |

**Trade Log Table (below charts):**

- Full trade-by-trade log: Entry time, Exit time, Symbol, Side, Entry Price, Exit Price, P&L (pips + currency), R-Multiple, Duration, Reason for exit

#### Results Comparison Tab

- Select 2-4 backtest runs to compare side-by-side
- Overlay equity curves on same chart (different colors per run)
- Comparison table: all KPIs in rows, runs in columns, best value highlighted

**API Endpoints Used:**

- `POST /backtest`
- `GET /backtest/{id}`
- `POST /backtest/list`
- `POST /walk-forward`
- `GET /walk-forward/{id}`
- `POST /walk-forward/list`

---

### 7.13 Strategy Ensemble & Allocation

Comprehensive portfolio-level strategy capital allocation monitoring and management.

**Tabs:** Current Allocation | Allocation History | Portfolio Analytics

#### Current Allocation Tab

**Summary Cards:**

- Total Portfolio Value, Allocated Capital %, Unallocated Capital, Portfolio Sharpe, Portfolio Max Drawdown

| Chart / Widget                        | Type             | Description                                                                                                                              |
| ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Allocation Donut**                  | Donut chart      | Inner ring: capital allocation by strategy. Center: total portfolio value. Hover shows strategy name + weight + absolute value           |
| **Strategy Leaderboard**              | Ranked card list | Each strategy card: name, allocation weight (progress bar), rolling Sharpe, 30d P&L sparkline, status badge. Sorted by Sharpe descending |
| **Allocation vs Performance Scatter** | Scatter plot     | X = allocation weight, Y = rolling Sharpe. Bubble size = absolute P&L. Identifies over/under-allocated strategies                        |
| **Correlation Matrix**                | Heatmap grid     | Strategy-to-strategy return correlation. Color scale: blue (negative correlation, good) → red (high correlation, concentration risk)     |

#### Allocation History Tab

- Paginated table of all past allocations with timestamp, before/after weights, trigger (manual / auto rebalance)
- **Allocation Weights Over Time** — stacked area chart showing how strategy weights evolved over time

#### Portfolio Analytics

| Chart                      | Type               | Description                                                                                                        |
| -------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Portfolio Equity Curve** | Area chart         | Aggregate portfolio-level equity over time                                                                         |
| **Contribution to Return** | Stacked bar        | Each bar = one time period. Stack segments = contribution from each strategy. Shows which strategies drive returns |
| **Risk Contribution**      | Donut              | Each strategy's contribution to portfolio variance. Reveals concentration risk                                     |
| **Efficient Frontier**     | Scatter with curve | Current portfolio position vs optimal portfolios. X = risk, Y = return                                             |

**Actions:**

- Trigger rebalance (`POST /strategy-ensemble/rebalance`) with preview of proposed changes
- View allocation history

**API Endpoints Used:**

- `POST /strategy-ensemble/rebalance`
- `GET /strategy-ensemble/allocations`
- `POST /strategy-ensemble/list`

---

### 7.14 Alerts

Configure and manage alert rules.

**List View:**

- Paginated table: ID, Name, Type, Symbol, Condition, Status (Active/Triggered/Disabled), Last Triggered
- Filters: Status, Type, Symbol

**Create/Edit Form:**

- Name, Type (PriceLevel, SignalGenerated, etc.)
- Symbol, Condition parameters
- Notification channels (Webhook, Email, SMS, Telegram)
- Cooldown period

**Actions:**

- Create, Update, Delete alert

**API Endpoints Used:**

- `POST /alert`
- `PUT /alert/{id}`
- `DELETE /alert/{id}`
- `GET /alert/{id}`
- `POST /alert/list`

---

### 7.15 Execution Quality

Comprehensive execution quality monitoring and analysis dashboard.

**Tabs:** Execution Log | Quality Analytics

#### Execution Log Tab

- Paginated table: ID, Order, Symbol, Requested Price, Filled Price, Slippage (pips, color-coded), Fill Latency (ms), Session, Strategy, Timestamp
- Filters: Symbol, Strategy, Session, Date Range, Slippage threshold
- Rows with excessive slippage (>1 pip) highlighted with warning tint

#### Quality Analytics Tab (comprehensive dashboard)

**KPI Summary Cards:**

- Avg Slippage (pips), Median Fill Latency (ms), Positive Slippage % (got better price), Total Executions, Worst Slippage Event

| Chart / Widget                | Type                 | Description                                                                                                                                          |
| ----------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slippage Over Time**        | Line chart with band | Rolling average slippage over time. Shaded ±1σ band. Alert threshold line. Trend arrow in header                                                     |
| **Slippage by Symbol**        | Horizontal bar chart | Average slippage per currency pair. Sorted worst to best. Color gradient red → green                                                                 |
| **Slippage Distribution**     | Histogram            | Full distribution of slippage values. Vertical lines at mean, median, and acceptable threshold. Positive slippage (price improvement) shown in green |
| **Fill Latency Over Time**    | Line chart with band | Rolling average latency. ±1σ band. Alert threshold line                                                                                              |
| **Fill Latency by Session**   | Grouped bar chart    | Average + P95 latency per session (London / New York / Tokyo / Sydney). Reveals session-dependent execution speed                                    |
| **Fill Latency Distribution** | Histogram            | Full latency distribution. Vertical lines at P50, P95, P99                                                                                           |
| **Slippage by Order Size**    | Scatter plot         | X = lot size, Y = slippage. Reveals if larger orders get worse fills                                                                                 |
| **Slippage by Time of Day**   | Heatmap (24 columns) | Hour-of-day slippage heatmap. Color intensity = avg slippage. Reveals time-dependent execution quality                                               |
| **Slippage by Strategy**      | Horizontal bar chart | Average slippage per strategy. Identifies strategies with consistently poor execution                                                                |
| **Execution Score Trend**     | Gauge + line chart   | Composite execution quality score (0-100) combining slippage + latency + fill rate. Trend line showing score over time                               |
| **Price Improvement Rate**    | Donut chart          | Percentage of trades with positive slippage (better price) vs negative slippage vs zero slippage                                                     |

**API Endpoints Used:**

- `POST /execution-quality`
- `GET /execution-quality/{id}`
- `POST /execution-quality/list`

---

### 7.16 Sentiment & Market Regime

Comprehensive macro market intelligence dashboard combining sentiment analysis and regime detection.

**Tabs:** Market Overview | Sentiment Deep Dive | Regime Analysis

#### Market Overview Tab (at-a-glance view of all symbols)

| Widget                     | Type        | Description                                                                                                                                                                      |
| -------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Symbol Sentiment Grid**  | Card grid   | One card per watched symbol. Each card: symbol name, sentiment gauge (bullish/bearish needle), current regime badge (Trending/Ranging/Volatile), directional arrow, confidence % |
| **Global Sentiment Radar** | Radar chart | Multi-axis radar showing sentiment scores across all major pairs. Quick visual of where the market leans                                                                         |
| **Regime Distribution**    | Donut chart | Current distribution of regimes across all symbols: % trending, % ranging, % volatile                                                                                            |

#### Sentiment Deep Dive Tab

**Symbol Selector:** Dropdown to focus on a specific currency pair

| Chart / Widget                     | Type               | Description                                                                                                               |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **Sentiment Gauge**                | Large gauge        | Bullish/Bearish needle gauge (-100 to +100) for selected symbol. Color gradient red → neutral → green                     |
| **Sentiment History**              | Area chart         | Sentiment score over time. Green fill above 0, red fill below 0. Overlaid with price line (dual axis) to show correlation |
| **COT Positioning**                | Stacked area chart | Commercial (blue), Non-Commercial (green), Retail (orange) net positions over time. Divergences highlighted               |
| **COT Net Change**                 | Bar chart          | Week-over-week change in net positioning per category. Momentum indicator                                                 |
| **COT Long/Short Breakdown**       | Grouped bar chart  | Side-by-side long vs short positions for each trader category. Current week                                               |
| **Sentiment vs Price Correlation** | Scatter plot       | X = sentiment score, Y = subsequent price change. Shows predictive power of sentiment                                     |
| **News Sentiment Timeline**        | Event timeline     | Chronological strip of news events with sentiment impact dots (green/red/gray). Hover for headline + impact score         |
| **Economic Events Calendar**       | Timeline / table   | Upcoming and recent economic events. Impact level (High/Medium/Low) color-coded. Forecast vs Actual columns               |

#### Regime Analysis Tab

**Symbol + Timeframe Selector**

| Chart / Widget                     | Type                     | Description                                                                                                       |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| **Current Regime**                 | Large badge card         | Current detected regime with ADX value, volatility reading, and confidence percentage                             |
| **Regime History Timeline**        | Horizontal segmented bar | Time axis with colored segments: blue = trending, yellow = ranging, red = volatile. Shows duration of each regime |
| **Regime Transition Matrix**       | Heatmap grid             | 3×3 matrix showing transition probabilities between regimes. Reveals typical regime sequences                     |
| **Regime Duration Distribution**   | Box plot set             | Three box plots (one per regime type) showing duration distribution. Median, quartiles, outliers                  |
| **ADX + Volatility Time Series**   | Dual-line chart          | ADX line and ATR/volatility line over time. Regime-colored background bands. Threshold lines at regime boundaries |
| **Strategy Performance by Regime** | Grouped bar chart        | Each strategy's win rate + profit factor per regime. Answers: which strategies work in which regimes?             |
| **Regime-Adjusted Returns**        | Line chart               | Portfolio returns segmented by regime. Separate colored lines per regime period                                   |

**Actions:**

- Record sentiment snapshot (`POST /sentiment/snapshot`)
- Ingest COT report (`POST /sentiment/cot`)

**API Endpoints Used:**

- `POST /sentiment/snapshot`
- `POST /sentiment/cot`
- `GET /sentiment/latest/{symbol}`
- `POST /sentiment/cot/list`
- `GET /market-regime/latest`
- `POST /market-regime/list`

---

### 7.17 Performance Attribution

Comprehensive multi-dimensional performance analysis dashboard — the analytical heart of the admin UI.

**Tabs:** Overview | Session Analysis | Regime Analysis | ML Analysis | Factor Decomposition

#### Overview Tab

**KPI Summary Cards:**

- Total P&L, Total Trades, Win Rate, Profit Factor, Sharpe Ratio, Sortino Ratio, Calmar Ratio, Max Drawdown %

| Chart / Widget                 | Type                        | Description                                                                                                                                    |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Strategy P&L Leaderboard**   | Ranked list with sparklines | Each strategy: name, total P&L (bar), win rate (mini gauge), 30d P&L sparkline, Sharpe. Sorted by P&L descending. Click to drill into strategy |
| **Cumulative P&L by Strategy** | Multi-line chart            | Each strategy as a separate colored line over time. Toggle individual strategies on/off. Aggregate line bold                                   |
| **P&L Contribution Waterfall** | Waterfall chart             | Sequential bars showing each strategy's contribution to total P&L. Positive bars up (green), negative down (red). Running total line           |
| **Monthly Returns Heatmap**    | Grid heatmap                | Rows = strategies, columns = months. Cell color = monthly return %. Sortable. Total row at bottom. Total column at right                       |
| **Risk-Adjusted Returns**      | Scatter plot                | X = max drawdown, Y = annualized return. Bubble size = trade count. Ideal strategies in top-left quadrant                                      |
| **Win Rate vs Profit Factor**  | Scatter plot                | Each strategy as a point. Quadrant lines at 50% win rate and 1.0 profit factor. Top-right = best performing                                    |

#### Session Analysis Tab

| Chart / Widget                  | Type                      | Description                                                                                                              |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **P&L by Session**              | Grouped bar chart         | Total P&L per session (London / New York / Tokyo / Sydney / Overlap). Each bar split by strategy (stacked option toggle) |
| **Win Rate by Session**         | Horizontal bar chart      | Win rate per session. Confidence interval whiskers. Trade count label on each bar                                        |
| **Session Performance Heatmap** | Heatmap grid              | Rows = strategies, columns = sessions. Cell color = P&L. Reveals which strategies work in which sessions                 |
| **Hourly P&L Profile**          | Bar chart (24 bars)       | Average P&L per hour of day. Color gradient green → red. Trade count overlay                                             |
| **Day-of-Week Performance**     | Grouped bar               | P&L per day of week. Separated by long vs short trades                                                                   |
| **Session Overlap Analysis**    | Venn-style or grouped bar | P&L during session overlaps (London-NY, Tokyo-London) vs pure sessions                                                   |

#### Regime Analysis Tab

| Chart / Widget                  | Type                 | Description                                                                                   |
| ------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| **P&L by Regime**               | Stacked bar chart    | P&L per regime (Trending / Ranging / Volatile). Stacked by strategy                           |
| **Win Rate by Regime**          | Grouped bar          | Win rate per regime per strategy                                                              |
| **Regime Duration vs P&L**      | Scatter plot         | X = regime duration, Y = P&L earned during that regime period                                 |
| **Optimal Strategy per Regime** | Table with icons     | Matrix: regimes vs strategies, cells show a star rating (1-5) based on historical performance |
| **Regime P&L Timeline**         | Segmented area chart | P&L line with background colored by active regime. Shows performance in context               |

#### ML Analysis Tab

| Chart / Widget                       | Type            | Description                                                                                                                       |
| ------------------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **P&L by ML Confidence Tier**        | Bar chart       | Bins: 0-20%, 20-40%, 40-60%, 60-80%, 80-100% confidence. P&L and win rate per bin. Reveals if higher confidence = better outcomes |
| **ML Score vs Trade P&L**            | Scatter plot    | Each trade: X = ML confidence, Y = realized P&L. Trendline overlay. R² annotation                                                 |
| **ML-Filtered vs Unfiltered**        | Dual line chart | Hypothetical equity curve with ML filter ON vs OFF. Shows ML model's value-add                                                    |
| **False Positive Cost Analysis**     | Bar chart       | Cost (negative P&L) from ML false positives vs gains from true positives. Net value calculation                                   |
| **Confidence Threshold Sensitivity** | Line chart      | X = confidence threshold, Y = resulting P&L if only trades above threshold were taken. Optimal threshold marked                   |

#### Factor Decomposition Tab

| Chart / Widget              | Type                 | Description                                                                                                                                                                    |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Attribution by Factor**   | Horizontal waterfall | P&L decomposed into factors: strategy alpha, market regime, session timing, ML signal quality, execution slippage, news proximity, MTF confluence. Each bar shows contribution |
| **News Proximity Impact**   | Bar chart            | P&L for trades taken near high-impact news vs far from news. Split by before/after event                                                                                       |
| **MTF Confluence Impact**   | Bar chart            | P&L for trades with multi-timeframe confluence vs without. Shows confluence filter value                                                                                       |
| **Correlation Risk Impact** | Scatter plot         | P&L vs portfolio correlation at time of trade. Shows if correlated exposure hurts                                                                                              |

**API Endpoints Used:**

- `GET /performance/{strategyId}`
- `GET /performance/all`

---

### 7.18 Drawdown Recovery

Comprehensive drawdown monitoring and risk state management dashboard.

**Layout:** Status hero section → charts grid → controls

#### Status Hero Section

| Widget                     | Type                   | Description                                                                                                                                                        |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Drawdown Gauge**         | Large gauge (center)   | Current drawdown % with threshold markers: Warning (yellow arc), Recovery (orange arc), Pause (red arc). Animated needle. Pulsing glow when in recovery/pause mode |
| **Recovery Mode Badge**    | Status card            | Large badge: Normal (green) / Warning (yellow, pulsing) / Recovery (orange, pulsing) / Paused (red, pulsing). Shows time in current mode                           |
| **Peak vs Current Equity** | Dual number comparison | Peak equity (with date) on left, current equity on right. Delta shown between them. Connecting line shows the gap                                                  |
| **Lot Size Reduction**     | Progress bar card      | Current lot size multiplier (e.g., 0.5x) with progress bar showing normal → reduced → minimum range                                                                |

#### Charts Grid

| Chart                        | Type                     | Description                                                                                                                                                                                 |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drawdown History**         | Inverted area chart      | Peak-to-trough drawdown over time. Color gradient intensifies as drawdown deepens. Threshold lines for Warning / Recovery / Pause levels. Recovery mode periods shaded in orange background |
| **Equity vs Peak Equity**    | Dual line chart          | Actual equity (blue) vs peak equity (dotted gray). Gap between them = drawdown. Shaded region = drawdown area                                                                               |
| **Drawdown Duration**        | Bar chart                | Duration of each drawdown event. Color intensity = depth. Horizontal line at average recovery time                                                                                          |
| **Recovery Time Analysis**   | Scatter plot             | X = drawdown depth %, Y = recovery time (days). Trendline shows expected recovery time for given depth                                                                                      |
| **Drawdown Frequency**       | Histogram                | Distribution of drawdown depths. Bins colored by severity. VaR (Value at Risk) line annotated                                                                                               |
| **Underwater Equity Curve**  | Area chart               | Same as equity curve but zeroed at peak — shows only underwater periods. Green when at or above peak, red when below                                                                        |
| **Mode Transition Timeline** | Horizontal segmented bar | Time axis with colored segments: green = Normal, yellow = Warning, orange = Recovery, red = Paused. Duration labels                                                                         |

**Actions:**

- Record drawdown snapshot (`POST /drawdown-recovery`)
- Manual override: Force recovery mode / Force normal mode (with confirmation dialog)

**API Endpoints Used:**

- `POST /drawdown-recovery`
- `GET /drawdown-recovery/latest`

---

### 7.19 Paper Trading

Toggle and monitor simulated trading mode.

**Paper Trading Panel:**

- Status badge: Enabled / Disabled
- Toggle switch to enable/disable
- Simulated vs. live indicator in header (persistent warning banner when paper trading is active)
- Simulated balance, slippage, fill delay settings (read from engine config)

**Actions:**

- Enable/Disable paper trading (`PUT /paper-trading/mode`)

**API Endpoints Used:**

- `PUT /paper-trading/mode`
- `GET /paper-trading/status`

---

### 7.20 Engine Configuration

Hot-reload engine parameters without restart.

**Config Editor:**

- Table of all configuration keys with current values
- Inline editing with save button
- JSON value editor for complex configs
- Grouped by category (Trading, Risk, ML, Workers, Market Data, etc.)

**Actions:**

- Upsert config (`PUT /config`)
- View config by key (`GET /config/{key}`)
- View all configs (`GET /config/all`)

**API Endpoints Used:**

- `PUT /config`
- `GET /config/{key}`
- `GET /config/all`

---

### 7.21 Audit Trail

Searchable, immutable log of all engine decisions.

**List View:**

- Paginated table: Timestamp, Decision Type, Entity, Action, Reason, Context (JSON)
- Filters: Decision Type, Entity, Date Range
- Full-text search across reason and context fields
- Expandable rows showing full JSON context

**API Endpoints Used:**

- `POST /audit-trail`
- `POST /audit-trail/list`

---

### 7.22 System Health

Comprehensive real-time engine health monitoring and infrastructure dashboard.

**Tabs:** System Overview | Worker Monitor | Infrastructure | API Quota

**Auto-refresh:** Every 10 seconds across all tabs

#### System Overview Tab

**Hero Status:**

- Large overall engine status: Healthy (green glow) / Degraded (yellow pulse) / Unhealthy (red pulse)
- Uptime counter (days, hours, minutes)
- Last restart timestamp

| Widget                    | Type                     | Description                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subsystem Status Grid** | Card grid (7 cards)      | One card per worker group: Core Trading, Market Data, Risk Monitoring, ML Training, ML Monitoring, Backtesting, Alerts. Each card: name, status indicator (green/yellow/red dot with glow), worker count, last heartbeat relative time. Click to expand details |
| **Health Timeline**       | Horizontal segmented bar | Last 24 hours as a timeline bar. Green = healthy, yellow = degraded, red = unhealthy. Hover for timestamp + details of status changes                                                                                                                           |
| **Active Workers**        | Donut chart              | Workers by status: Running (green), Idle (blue), Error (red), Stopped (gray). Center shows total count                                                                                                                                                          |
| **Error Rate**            | Line chart               | Errors per minute over last hour. Spike detection with annotations                                                                                                                                                                                              |

#### Worker Monitor Tab

| Chart / Widget                | Type              | Description                                                                                                                                                                     |
| ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Worker Table**              | Full-width table  | All 85+ background workers: Name, Group, Status (badge), Interval, Last Execution, Duration (ms), Error Count, CPU %. Sortable, filterable by group. Error rows highlighted red |
| **Worker Execution Timeline** | Gantt-style chart | Horizontal bars showing when each worker executed over the last hour. Overlapping executions visible. Red markers for failures                                                  |
| **Worker Duration Trend**     | Multi-line chart  | Average execution duration per worker group over time. Spike detection for performance degradation                                                                              |
| **Error Heatmap**             | Heatmap grid      | Rows = workers, columns = time buckets (last 24h). Color intensity = error count. Quickly identifies problematic workers                                                        |

#### Infrastructure Tab

| Widget                     | Type                        | Description                                                                                                                                    |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database Status**        | Card with gauge             | Connection pool utilization gauge. Avg query latency. Active connections count. Status: Connected (green) / Slow (yellow) / Disconnected (red) |
| **RabbitMQ Status**        | Card with metrics           | Queue depth, messages/sec in, messages/sec out, consumer count. Status indicator. Queue depth sparkline                                        |
| **Broker Health**          | Card per broker             | Broker name, connection status (badge), API latency (ms), last successful call, error rate. Health check button                                |
| **Memory & CPU**           | Dual gauge                  | Application memory usage (MB) gauge + CPU % gauge. Trend sparklines                                                                            |
| **Event Bus Throughput**   | Area chart                  | Integration events published per minute over last hour. Colored by event type                                                                  |
| **Database Query Latency** | Line chart with percentiles | P50, P95, P99 query latency over time. Alert threshold line                                                                                    |

#### API Quota Tab

| Widget                     | Type                  | Description                                                                                            |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| **Quota Usage per Broker** | Gauge set             | One gauge per broker API: requests used / limit. Color transitions green → yellow → red as quota fills |
| **Quota Usage Over Time**  | Stacked area chart    | API calls per endpoint over time. Total vs limit line                                                  |
| **Rate Limit Events**      | Scrolling log         | Recent rate limit hits: timestamp, broker, endpoint, queue depth. Warning tint on rows                 |
| **Token Bucket State**     | Visual bucket diagram | Current tokens available vs bucket capacity per broker endpoint. Refill rate displayed                 |

**API Endpoints Used:**

- `GET /health/status`
- `GET /broker/health`
- `GET /rate-limit/quota/{brokerKey}`

---

## 8. Shared UI Components

### Data Table

A reusable `DataTableComponent<T>` wrapping AG Grid with the custom Apple-inspired theme:

- Server-side pagination with pill-style page controls
- Column sorting (maps to `sortBy` / `sortDirection` in PagerRequest)
- Search input with magnifying glass icon and blur focus ring
- Column visibility toggle via dropdown
- Row actions via contextual icon button (ellipsis menu)
- Skeleton shimmer loading state matching row layout
- Elegant empty state with muted illustration and call-to-action
- Bulk selection with custom-styled checkboxes
- Virtual scrolling for large datasets

### Status Badge

Consistent badge component for entity statuses:

- Order: Pending (yellow), Submitted (blue), Filled (green), Cancelled (gray), Rejected (red), Failed (red)
- Position: Open (blue), Closed (gray)
- Strategy: Active (green), Paused (yellow), Disabled (gray)
- Signal: Pending (yellow), Approved (green), Rejected (red), Expired (gray)
- Broker: Connected (green), Disconnected (red), Error (red)
- Health: Healthy (green), Degraded (yellow), Unhealthy (red)

### Confirmation Dialog

Apple-style centered modal for destructive actions (delete, cancel order, switch broker):

- Glassmorphism backdrop with blur
- Scale-in animation on open
- Clear description of consequence
- Right-aligned actions: secondary Cancel (ghost) + primary Confirm (destructive red or accent)
- Button shows inline spinner during action

### Detail Panel

Side panel or full-page detail view with:

- Header (entity name, status badge, actions dropdown)
- Tabbed content sections
- Related entities as linked tables

### Form Components

- `FormFieldComponent` — label above input + animated error message with slide-down transition
- `SelectFieldComponent` — dropdown with search, custom-styled options with hover highlight, origin-point scale animation
- `JsonEditorComponent` — syntax-highlighted JSON editor with line numbers, matching the dark code-editor aesthetic
- `DateRangePickerComponent` — dual calendar popup with range highlighting, pill-style presets (Today, 7d, 30d, 90d)
- `NumberInputComponent` — with stepper arrows, min/max/step, and currency/percentage formatting using `tabular-nums`

---

## 9. Navigation & Layout

### App Shell

```
┌──────────────────────────────────────────────────────┐
│  Logo   │  Search (Cmd+K)  │  Paper Trading │ User  │
├─────────┼────────────────────────────────────────────┤
│         │                                            │
│ Sidebar │              Main Content                  │
│         │                                            │
│ Dashboard│                                           │
│         │                                            │
│ TRADING │                                            │
│ Orders  │                                            │
│ Positions│                                           │
│ Signals │                                            │
│         │                                            │
│ CONFIG  │                                            │
│ Strategies│                                          │
│ Accounts│                                            │
│ Brokers │                                            │
│ Risk    │                                            │
│ Pairs   │                                            │
│ Alerts  │                                            │
│         │                                            │
│ ML      │                                            │
│ Models  │                                            │
│ Training│                                            │
│ Backtest│                                            │
│         │                                            │
│ ANALYSIS│                                            │
│ Perform.│                                            │
│ Exec Qual│                                           │
│ Sentiment│                                           │
│ Regime  │                                            │
│ Ensemble│                                            │
│         │                                            │
│ SYSTEM  │                                            │
│ Health  │                                            │
│ Config  │                                            │
│ Audit   │                                            │
│ Drawdown│                                            │
│ Paper   │                                            │
└─────────┴────────────────────────────────────────────┘
```

### Sidebar Groups

| Group             | Items                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| —                 | Dashboard                                                                    |
| Trading           | Orders, Positions, Trade Signals                                             |
| Configuration     | Strategies, Trading Accounts, Brokers, Risk Profiles, Currency Pairs, Alerts |
| ML & Optimization | ML Models, Training Runs, Backtesting, Walk-Forward                          |
| Analysis          | Performance, Execution Quality, Sentiment, Market Regime, Strategy Ensemble  |
| System            | Health, Engine Config, Audit Trail, Drawdown Recovery, Paper Trading         |

### Header

- Application logo and name
- Global search (Cmd+K) — searches across all entities
- Paper trading mode indicator (persistent orange banner when active)
- User avatar and logout

### Breadcrumbs

Auto-generated from route path with chevron separators: `Dashboard › Orders › ORD-12345` — styled in `var(--text-secondary)` with the last segment in `var(--text-primary)`

---

## 10. Data Patterns

### Pagination

All list endpoints use POST with `PagerRequest` body. The `DataTable` component manages:

- `pageNumber` (1-indexed)
- `pageSize` (10, 25, 50, 100 selector)
- `searchTerm` (debounced text input, 300ms)
- `sortBy` / `sortDirection`

### Polling Strategy

| Data Type          | Interval  | Condition                                       |
| ------------------ | --------- | ----------------------------------------------- |
| Open positions P&L | 15s       | Only when positions page or dashboard is active |
| Live prices        | 5s        | Only when market data page is active            |
| System health      | 15s       | Only when health page or dashboard is active    |
| Pending signals    | 15s       | Only when signals page or dashboard is active   |
| Account balance    | 30s       | Only when dashboard is active                   |
| Everything else    | On-demand | Fetched on page load, refetched on window focus |

### Optimistic Updates

Status changes are applied optimistically via local signal updates while the API call is in flight:

- Approve/Reject signal
- Activate/Pause strategy
- Activate broker
- Toggle paper trading
- Cancel order

On API error, the local state is rolled back and a snackbar error is shown.

### Data Refresh

After mutating an entity:

- Re-fetch that entity's list via the service
- Re-fetch related entity data (e.g., after creating an order, refresh positions list)
- Re-fetch dashboard summary data
- Services use `BehaviorSubject` or signals to notify dependent components of changes

---

## 11. Charts & Visualization

### Chart Types Used

| Chart                | ECharts Type                          | Used In                                                                                       |
| -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Line chart           | `line` with smooth curves             | Equity curve, accuracy over time, win rate trends, price analytics                            |
| Multi-line           | `line` (multiple series)              | Strategy comparison, champion vs challenger, cumulative P&L overlays                          |
| Bar chart            | `bar` with rounded corners            | Daily P&L, slippage by symbol, attribution, session analysis                                  |
| Grouped bar          | `bar` with grouped series             | Attribution by session/regime, win rate by session, COT breakdown                             |
| Stacked bar          | `bar` (stacked)                       | P&L contribution, regime P&L, session overlap analysis                                        |
| Waterfall            | `bar` (custom)                        | P&L contribution waterfall, factor attribution decomposition                                  |
| Horizontal bar       | `bar` (horizontal)                    | Feature importance, strategy leaderboard, slippage by symbol                                  |
| Area chart           | `line` with `areaStyle` gradient fill | Cumulative P&L, drawdown area, sentiment history, COT positioning                             |
| Stacked area         | `line` (stacked `areaStyle`)          | Allocation weights over time, contribution to return, quota usage                             |
| Donut chart          | `pie` (ring variant)                  | Strategy allocation, regime distribution, agreement rate, risk contribution                   |
| Gauge                | `gauge` with arc style                | Drawdown %, risk compliance, sentiment, execution quality score, model accuracy               |
| Sparkline            | `line` (mini, no axis)                | Metric cards, table row inline trends, price movement                                         |
| Heatmap              | `heatmap`                             | Correlation matrix, monthly returns, trade outcome by hour/day, spread by hour, worker errors |
| Calendar heatmap     | `heatmap` (calendar layout)           | Trade outcome by day-of-week × hour, daily P&L calendar                                       |
| Treemap              | `treemap`                             | Position exposure, symbol exposure, portfolio allocation                                      |
| Scatter plot         | `scatter`                             | Hold duration vs P&L, MAE/MFE, R-multiple over time, risk-adjusted returns, slippage vs size  |
| Histogram            | `bar` (custom bins)                   | P&L distribution, slippage distribution, R-multiple distribution, confidence distribution     |
| Box plot             | `boxplot`                             | Regime duration, confidence comparison, latency percentiles                                   |
| Radar chart          | `radar`                               | Global sentiment, multi-metric strategy comparison                                            |
| Parallel coordinates | `parallel`                            | Hyperparameter search visualization                                                           |
| Gantt / Timeline     | `custom` (rect series)                | Worker execution timeline, regime history, mode transition timeline                           |
| Segmented bar        | `custom`                              | Health timeline, regime timeline, drawdown recovery modes                                     |

### Chart Styling

- **Apple-inspired palette:** Soft gradients, no harsh solid fills — area charts use gradient fills fading to transparent
- **Colors:** `#0071E3` (accent blue), `#34C759` (profit green), `#FF3B30` (loss red), `#FF9500` (warning), `#AF52DE` (purple), `#5AC8FA` (cyan)
- **Profit/Loss:** Green gradient for positive, red gradient for negative — never flat solid fills
- **Grid lines:** Very subtle at 4% opacity, no heavy axis lines
- **Tooltips:** Glassmorphism style (blur backdrop, rounded corners, shadow) matching the app design language
- **Animations:** Smooth chart entry animations (lines draw in, bars grow up, donuts sweep)
- **Responsive:** Charts resize fluidly within their card containers
- **Typography:** Chart labels use the same font stack and sizing as the app (SF Pro / Inter)
- **Interactive:** Crosshair cursor on hover, highlighted data points, smooth tooltip follow
- **Legend:** Positioned below chart, pill-style items with color dot + label

---

## 12. Error Handling & Notifications

### API Error Handling

```typescript
// HttpInterceptor (functional)
export const errorInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    tap((event) => {
      if (event instanceof HttpResponse) {
        const body = event.body as ResponseData<unknown>;
        if (body?.responseCode === '-11') {
          // Show snackbar with validation errors
        } else if (body?.responseCode === '-14') {
          // Navigate to list page (not found)
        } else if (body?.responseCode !== '00') {
          // Show snackbar with responseMessage
        }
      }
    }),
  );
```

### Toast Notifications

Using the custom glassmorphism toast component (see Section 3.1):

- **Success** (green): Entity created/updated/deleted, action completed
- **Error** (red): API error, validation failure, network error
- **Warning** (yellow): Paper trading mode active, drawdown warning
- **Info** (blue): Background operation started (training, backtest queued)

### Loading States

- **Page-level:** Full-page skeleton shimmer matching the page layout (no spinners)
- **Table:** Skeleton shimmer rows matching column count and widths
- **Detail:** Skeleton blocks matching content sections with animated gradient sweep
- **Action buttons:** Disabled at 40% opacity + 16px inline spinner during mutation
- **Charts:** Skeleton rectangle with shimmer in the chart container

### Error Handling

Angular `ErrorHandler` override at the application level to catch unhandled errors and show a fallback UI with a retry button. Route-level error components via Angular Router's error handling.

### Offline / Network Error

Banner at the top of the page when network connectivity is lost. Queries paused until reconnection.

---

## 13. Implementation Phases

### Phase 1 — Foundation (Weeks 1-2)

**Goal:** Project scaffold, auth, layout, and first feature module

- [ ] Initialize Angular 19 project via `ng new` with standalone components, SCSS, and SSR disabled
- [ ] Install and configure dependencies (Tailwind CSS, AG Grid, ngx-echarts, lucide-angular)
- [ ] Set up project structure (folders, path aliases, angular-eslint, Prettier)
- [ ] Implement design system foundation: CSS custom properties, color tokens (light + dark), typography scale, spacing scale
- [ ] Build core UI primitives: ButtonComponent, InputComponent, BadgeComponent, CardComponent, SkeletonComponent
- [ ] Implement API client layer (ApiService, HttpInterceptors, response types)
- [ ] Implement authentication flow (login page, AuthService, auth guard, auth interceptor)
- [ ] Build app shell (glassmorphism sidebar, header with search, breadcrumbs, responsive layout, dark mode toggle)
- [ ] Build shared `DataTableComponent` with AG Grid custom Apple theme, pagination, sorting, search
- [ ] Build shared form components and status badges
- [ ] **Feature: Dashboard** — summary cards, basic charts
- [ ] **Feature: System Health** — status page

### Phase 2 — Core Trading (Weeks 3-4)

**Goal:** Full trading operations management

- [ ] **Feature: Orders** — list, detail, create, submit, cancel, modify
- [ ] **Feature: Positions** — list, detail, trailing stop updates, scaling
- [ ] **Feature: Trade Signals** — list, detail, approve/reject/expire, bulk actions
- [ ] **Feature: Trading Accounts** — CRUD, activate, sync balance
- [ ] **Feature: Brokers** — CRUD, activate, switch, health check
- [ ] **Feature: Currency Pairs** — CRUD
- [ ] **Feature: Market Data** — live prices panel, candle history

### Phase 3 — Configuration & Risk (Weeks 5-6)

**Goal:** Strategy and risk management

- [ ] **Feature: Strategies** — CRUD, activate/pause, assign risk profile, JSON parameter editor
- [ ] **Feature: Risk Profiles** — CRUD, linked strategies
- [ ] **Feature: Alerts** — CRUD, notification channel configuration
- [ ] **Feature: Engine Configuration** — config editor, grouped key-value management
- [ ] **Feature: Paper Trading** — toggle, status indicator, header banner
- [ ] **Feature: Drawdown Recovery** — status panel, gauge chart
- [ ] **Feature: Audit Trail** — searchable paginated log

### Phase 4 — ML & Analytics (Weeks 7-8)

**Goal:** ML lifecycle and analytical features

- [ ] **Feature: ML Models** — list, detail, activate, rollback
- [ ] **Feature: Training Runs** — list, trigger training, trigger hyperparam search
- [ ] **Feature: Shadow Evaluation** — start evaluation, results comparison
- [ ] **Feature: Backtesting** — queue runs, results with equity curve
- [ ] **Feature: Walk-Forward** — queue runs, results
- [ ] **Feature: Strategy Ensemble** — allocations view, rebalance trigger

### Phase 5 — Advanced Analytics & Polish (Weeks 9-10)

**Goal:** Analytical dashboards and UX polish

- [ ] **Feature: Performance Attribution** — multi-dimension attribution charts
- [ ] **Feature: Execution Quality** — slippage/latency charts, trend analysis
- [ ] **Feature: Sentiment & Regime** — sentiment gauges, regime badges, COT charts
- [ ] **Feature: Economic Events** — CRUD, calendar view
- [ ] Global search (Cmd+K) with cross-entity results
- [ ] Dashboard enhancements — additional charts, quick actions
- [ ] Dark mode support
- [ ] Keyboard shortcuts for common actions
- [ ] Responsive layout testing and fixes

### Phase 6 — Testing & Deployment (Weeks 11-12)

**Goal:** Quality assurance and production readiness

- [ ] Unit tests for services and utility functions
- [ ] Component tests for shared components (DataTableComponent, forms, badges)
- [ ] Integration tests for critical workflows (auth, order creation, signal approval)
- [ ] E2E tests for key user journeys (Playwright)
- [ ] Performance optimization (lazy-loaded routes, `@defer` blocks, `OnPush` change detection)
- [ ] Docker containerization
- [ ] CI/CD pipeline (build, lint, test, deploy)
- [ ] Environment configuration (dev, staging, production API URLs)
- [ ] Documentation (README, component storybook)

---

## 14. Non-Functional Requirements

### Performance

| Metric                     | Target                           |
| -------------------------- | -------------------------------- |
| Initial page load (LCP)    | < 2 seconds                      |
| Route navigation           | < 500ms                          |
| Table re-render (100 rows) | < 100ms                          |
| Bundle size (gzipped)      | < 500 KB initial, < 1.5 MB total |
| API response handling      | < 50ms client-side processing    |

### Browser Support

- Chrome 120+
- Firefox 120+
- Safari 17+
- Edge 120+

### Accessibility

- WCAG 2.1 AA compliance
- Keyboard navigable (all actions reachable without mouse)
- Screen reader compatible (Angular Material provides ARIA attributes via CDK a11y)
- Focus management on modals and dialogs
- Color contrast ratios meet AA standards

### Security

- JWT stored in memory only (not localStorage/sessionStorage)
- All API calls over HTTPS
- No sensitive data in URL parameters
- Input sanitization on all form fields
- CSP headers configured
- No inline scripts

### Code Quality

- TypeScript strict mode
- ESLint with angular-eslint recommended rules
- Prettier for consistent formatting
- Pre-commit hooks (lint + format)
- Minimum 80% test coverage on shared components and API layer

---

_End of document._

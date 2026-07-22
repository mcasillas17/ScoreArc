# Colour system — semantic palette + per-competition accent

**Status:** Design approved (brainstorming) · 2026-07-22
**Scope:** One implementation plan. Presentation-only (no data/behaviour changes). Dark-only (the app commits to dark).

## Goal

The UI is monochrome gold — one accent does brand, active states, labels, live,
data and prize, so nothing stands out. Introduce a two-layer colour system:

1. **Semantic layer (global, identical everywhere):** colours that encode
   meaning — live, win, loss, draw, info/interactive.
2. **Identity layer (per competition):** an accent colour for the brand chrome
   (section labels, day tags, active nav, ticker), so each competition feels
   like itself.

Gold stops being the default. It is reserved for **ScoreArc's global brand**
(home hub + wordmark) and the **prize/qualification** signal (Liguilla arc,
champion crown, standings qualify band).

Reference: approved mockups (`combined-palette` artifact) and the approved
per-competition accent table below.

## Accent palette (approved)

Each `Competition` gets `accent: { base, bright, soft }`. `soft` is a low-alpha
tint for backgrounds/borders.

| Competition | base | bright | soft |
|---|---|---|---|
| world-cup | `#e8b84b` | `#f0c873` | `rgba(232,184,75,0.16)` |
| liga-mx | `#22a95e` | `#3ed07f` | `rgba(34,169,94,0.16)` |
| premier-league | `#8b5cf6` | `#b18bff` | `rgba(139,92,246,0.16)` |
| laliga | `#e5484d` | `#ff6b6b` | `rgba(229,72,77,0.16)` |
| serie-a | `#3b82f6` | `#6ba7ff` | `rgba(59,130,246,0.16)` |
| bundesliga | `#d20515` | `#ff5a4d` | `rgba(210,5,21,0.16)` |
| ligue-1 | `#1e40af` | `#5b7fe0` | `rgba(30,64,175,0.16)` |
| mls | `#2c5282` | `#5b8fd0` | `rgba(44,82,130,0.16)` |
| leagues-cup | `#0d9488` | `#2dd4bf` | `rgba(13,148,136,0.16)` |

World Cup's accent equals the current gold, so WC pages look unchanged.

## Semantic tokens (added once to `:root`)

```
--live: #ff5c5c;   --win: #35c17b;   --loss: #e5533d;   --draw: #55555f;
--info: #4a90d9;   --info-bright: #8fbdec;
```

These are global and never per-competition.

## Injection

`WorkspaceLayout` (`src/app/c/[comp]/[season]/layout.tsx`) already renders
`<div className="app-shell">` with `rc.competition` in scope. Set the accent as
inline CSS custom properties there:

```tsx
<div
  className="app-shell"
  style={{
    ['--accent' as string]: comp.accent.base,
    ['--accent-bright' as string]: comp.accent.bright,
    ['--accent-soft' as string]: comp.accent.soft,
  }}
>
```

This cascades to both the sidebar and the main content. `:root` also defines
`--accent*` = gold as a fallback (so any page without the wrapper — e.g. the
home hub — is gold).

## The gold audit — three buckets

Every existing `var(--gold)` / `var(--gold-bright)` usage (and the few hardcoded
`#e8b84b`/`#f0c873`) is sorted into one bucket. The plan enumerates exact lines;
the rules:

### Bucket A — Brand chrome → `var(--accent)` / `var(--accent-bright)`
The competition-identity chrome. Includes:
- Sidebar: `.nav-item--active` (::before bar + icon), `.mtab--active`,
  `.cs-current:hover`, `.cs-opt--active`, `.sidebar-allcomps:hover`,
  `.sidebar-credit:hover`.
- Section labels: `.bracket-eyebrow`, `.std-block-title`.
- Ticker: `.tick-day`, `.tick-band` accent border, `.tick-wp-h` +
  `.tick-wp-legend .l` (home = the competition), upcoming badge.
- Controls / interactive hovers: `.bz-controls button:hover`,
  `.bracket-mode--active`, `.bracket-reset:hover`, `.md-close:hover`,
  `.nw-card:hover`, `.nw-time`, `.mh-thumb-btn:hover .mh-play`,
  `.wc-tl-*` (timeline hover/active/playhead), `.lu-formation`, `.cm-min`,
  `.ls-stat-poss-home`, `.ls-stat-bar-home` fallback,
  `.collapsible-toggle` `--pill-color` fallback, `.match-score`, `.md-status`,
  `.ls-pens-badge`, `.mh-goal`.

### Bucket B — Prize / qualification → `var(--qual, var(--gold))`
Gold earns these; a competition may later override `--qual`, else it stays gold:
- Champion: all `.champ-*` (subtitle, halo, laurel, caption, crown) and the
  RadialBracket hardcoded champion/trophy golds + winner-disc ring.
- Liguilla / qualification: `.ll-dot--in`, `.ll-band-label--in`, `.ll-row--in`,
  `.ll-cutline`, the dial `.lld-arc*` gold, and `.std-swatch` +
  `.standings-table tr.row-qualify` qualify stripe.

`--qual` / `--qual-bright` default to gold in `:root`; not set per competition in
v1 (Liga MX already uses gold for the Liguilla — correct).

### Bucket C — Global brand → stays gold
Not tied to any one competition:
- `.sidebar-wordmark` (the ScoreArc logo), and the home hub: `.hub-word`,
  `.hub-group-label--upcoming`, `.hub-tile:hover`, `.hub-badge--upcoming`.

### Semantic → new tokens
- `.tick-pop-more` ("Full details ›") → `var(--info-bright)` (interactive).
- (Live/win/loss tokens are defined now and used where live/result state is
  already shown; see Out of scope for recent-form pills.)

## Config & types

`competitions.ts`: add to `Competition`:

```ts
accent: { base: string; bright: string; soft: string };
```

Set for all nine competitions (table above). It is required (not optional) so
every competition has an identity; the `:root` gold fallback covers non-workspace
pages.

## Testing

- **Unit:** `competitions.test.ts` asserts every competition defines a valid
  `accent` with the three keys (and that world-cup's base is the gold `#e8b84b`).
- **Presentational:** visual verification across Liga MX (green), Premier League
  (purple), World Cup (gold, unchanged) and the home hub (gold) — confirm brand
  chrome takes the accent, prize/Liguilla stays gold, "Full details" is blue,
  and no element that should be gold went accent (or vice-versa).
- `npx tsc --noEmit` clean; `npm test` green; `npm run build`.

## Out of scope (YAGNI / future)

- **Recent-form W/D/L pills** in standings — needs per-team recent-results data
  the app doesn't fetch yet; the mockup's green/red form is a fast-follow.
- **Per-competition prize colours** beyond gold (e.g. Premier League blue
  Champions-League zone + red relegation) — those zones aren't implemented.
- **Light theme** — the app is dark-only by design.
- Any data, layout, or behaviour change.

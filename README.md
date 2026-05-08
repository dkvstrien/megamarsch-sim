# megamarsch-sim

Browser-based simulator for the Megamarsch München 100 km hike. Sign up, name a walker, pick a fitness band, watch your walker move along the Munich → Mittenwald route over 24 hours.

## What This Is

- ~150 walkers per cohort move along the real route over 24 hours
- Pace decay model calibrated against 4 real Munich finishers (`α = 0.30`)
- Five fitness bands (Comfortable / Steady / Strong / Fast / Elite)
- Historical 37% finish rate honored — walkers can DNF
- Sandbox mode (start any time) + race-day mode (aligned with real event windows)

## Getting Started

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Commands

- Install: `npm install`
- Run dev: `npm run dev`
- Build: `npm run build`
- Preview build: `npm run preview`
- Deploy: `npm run deploy` (Cloudflare Pages, see below)

## Deploy (Cloudflare Pages)

First time only:

```bash
npx wrangler login          # opens a browser window — sign in to Cloudflare
```

Each deploy after that:

```bash
npm run deploy
```

That runs `vite build`, then pushes `dist/` to a Cloudflare Pages project named `megamarsch-sim`. Wrangler creates the project on first deploy. After it finishes you'll get a URL like `https://megamarsch-sim.pages.dev` plus a unique-per-deploy preview URL.

Custom domain: set it up in the Cloudflare dashboard once the project exists (Pages → megamarsch-sim → Custom domains).

## Architecture

Frontend-only for v0. The full vision adds a Cloudflare Workers + D1 backend for sign-up persistence, but the model and rendering work standalone.

Key files:

- `src/model.ts` — pace decay equation, fitness bands, finish-time computation
- `src/route.ts` — loads route GPX into a cumulative-km polyline
- `src/walkers.ts` — generates a cohort with realistic band distribution
- `src/main.ts` — wires MapLibre + deck.gl TripsLayer + time controls
- `public/route.gpx` — official 2026 Megamarsch München route (from the companion repo)

## External Dependencies

- [MapLibre GL JS](https://maplibre.org/) — vector map base
- [deck.gl](https://deck.gl) — animated walker layer (`TripsLayer`)
- [@tmcw/togeojson](https://github.com/tmcw/togeojson) — GPX → GeoJSON parser

No backend, no API keys, no accounts. v0 runs entirely client-side.

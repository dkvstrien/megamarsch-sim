# Megamarsch Sim

Browser-based simulator for the [Megamarsch München](https://www.megamarsch.de/) 100 km hike. Watch 200 simulated walkers (or up to 1200) progress along the real Munich → Mittenwald route over 28 hours, alongside actual GPS recordings from participants.

**[→ Open the sim](https://danielvanstrien.github.io/megamarsch-sim)**

## Features

- **200 simulated walkers** across 6 fitness bands (Beginner → Elite), with wave starts, checkpoint rest stops, fatigue, weather effects, and DNFs
- **Replay real GPX tracks** from GPS watches alongside the simulation
- **Time-aligned mode** — see how friends' actual start times compare
- **Schlussläufer & Vorläufer** — official pace-setters sweeping the course
- **Histogram** showing walker density along the route
- **Strava bookmarklet** — one-click GPX export with full timestamps

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

## Importing Strava data

Open [`/strava-bookmarklet.html`](https://danielvanstrien.github.io/megamarsch-sim/strava-bookmarklet.html), drag the button to your bookmarks bar, then click it while viewing a Strava activity to download a GPX with full timestamps.

## Route

The official 2026 Megamarsch München route (Munich → Mittenwald, ~105 km), sourced from the [megamarsch-companion](https://gitlab.com/travistang1/megamarsch-companion) project.

## Architecture

- **MapLibre GL** base map
- **deck.gl** TripsLayer + ScatterplotLayer for animated walkers
- **Deterministic model** — walker positions are pure functions of (pace_0, α, start_time, dnf_km)
- **Ornstein-Uhlenbeck pace noise** for realistic speed variation
- **Vanilla TypeScript** — no React needed

## License

MIT

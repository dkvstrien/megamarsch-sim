# AGENTS.md — megamarsch-sim

This file provides context for AI coding agents working on this project.

---

## What This Project Is

A browser-based simulator for the Megamarsch München 100 km hike. Users sign up, name a walker, pick a fitness band (1–5), and watch their walker progress along the real Munich → Mittenwald route over 24 hours. Two modes:

- **Sandbox** — sign up any time, walker starts when you submit, watch in real time.
- **Race day** — sign up before the actual Megamarsch event; walkers run alongside the real participants.

The sim shows ~150 walkers per cohort. Most are auto-generated "filler" walkers with personas; the real ones are friends. Historical 37% finish rate is honored — DNFs happen.

## Project Structure

```
src/
  model.ts      — pace decay equation, 5 fitness bands, finish-time computation, DNF hazard
  route.ts      — load route GPX, build cumulative-km polyline
  walkers.ts    — generate cohort of walkers (real + filler) from band distribution
  main.ts       — entry: MapLibre + deck.gl TripsLayer + time scrubber
public/
  route.gpx     — Munich → Garmisch (102 km, derived from Komoot tour 2252549781)
index.html
```

## Route source

`public/route.gpx` is the **official 2026 Megamarsch München route**, sourced from the [megamarsch-companion](https://gitlab.com/travistang1/megamarsch-companion/-/blob/main/public/route.gpx) repo (Travis Tang's MIT-licensed PWA for the same event). 2475 trackpoints + 5 official waypoints (VPS1, Zwischenstation, Verpflegungsstation 2, VPS3, VPS4) at their real coordinates. Created via Komoot, exported to GPX.

`route.ts` parses the GPX in `loadRoute()`. It currently uses only the trkseg LineString — the `<wpt>` VPS markers aren't yet rendered on the map (TODO: pull them out and overlay as a fixed marker layer).

To refresh:

```sh
curl -sL "https://gitlab.com/travistang1/megamarsch-companion/-/raw/main/public/route.gpx" \
  -o public/route.gpx
```

Backend (added later, not present in v0):
```
worker/         — Cloudflare Worker (API: list/create/get walkers)
schema.sql      — D1 schema (walkers table)
```

## Commands

```bash
npm install       # install dependencies
npm run dev       # vite dev server (http://localhost:5173)
npm run build     # production build → dist/
npm run preview   # preview production build locally
```

## The model (one equation, calibrated to data)

```
pace(d_km) = pace_0 · (1 − α · d_km/100)        # linear pace decay
α = 0.30                                         # fixed, fit to 4 Munich finishers
T(d) = (100 / (pace_0 · α)) · ln(1 / (1 − α·d/100))   # closed-form time at km d
```

Five fitness bands, calibrated to Munich (970 m gain absorbed into pace_0):

| Band | Label        | pace_0 (km/h) | Flat-100km finish |
|------|-------------|---------------|-------------------|
| 1    | Comfortable | 5.0           | 23.78 h           |
| 2    | Steady      | 5.4           | 22.02 h           |
| 3    | Strong      | 6.0           | 19.82 h           |
| 4    | Fast        | 6.6           | 18.02 h           |
| 5    | Elite       | 7.5           | 15.85 h           |

Population mix for filler walkers: 35% / 30% / 20% / 10% / 5% (band 1 → 5).

DNF hazard targets the historical 37% finish rate; drop-outs cluster around km 55–80.

## Architecture Notes

- **Stateless backend.** Walker positions are deterministic functions of (pace_0, α, start_time, dnf_at_km). No simulator process to run. Endpoint just returns the registry; positions are computed client-side every frame.
- **deck.gl `TripsLayer`** does all the animation. We pre-compute each walker's `(timestamp, position)` array at sim start; deck.gl interpolates on the GPU.
- **Real-time vs accelerated** is a single variable: `viewing_time = now()` vs `viewing_time = event_start + (now() - replay_start) × speed`. Same rendering code path.

## Code Conventions

- TypeScript, strict mode.
- 2-space indent (TS convention).
- ES modules. No CommonJS.
- No React unless we hit a real reason. deck.gl works fine with vanilla DOM.
- Pure functions in `model.ts` — no I/O, no side effects. Tested separately if tests get added.

## Never

- Don't mutate walker objects after creation. Treat them as immutable; the model is a function of their fixed parameters.
- Don't add an authoritative simulator tick on the server. The whole architecture rests on determinism.
- Don't import the megamarsch-companion code as a dependency. Lift the model and route logic by hand if needed.

## Related Projects

- [megamarsch-companion](https://gitlab.com/travistang1/megamarsch-companion) — the live PWA used by participants during the actual event. We share the same fatigue-model design but are otherwise independent.

// Walker generation.
//
// A cohort = a fixed list of immutable walker definitions. Every walker is just
// a tuple of (name, band, pace_0 with jitter, start_offset, dnf_km). Their
// position at time t is a pure function — no state to update.

import {
  ALPHA,
  BANDS,
  ROUTE_KM,
  bandById,
  kmAtTime,
  rollDnfKm,
  timeAtKm,
} from "./model";
import type { Route } from "./route";
import { positionAtKm } from "./route";

export interface Walker {
  id: string;
  name: string;
  bandId: number;
  pace0: number;
  startOffsetMin: number; // minutes after the cohort's reference start
  dnfKm: number | null; // null = will finish
  isReal: boolean; // true = a real friend, false = filler
}

export interface CohortMeta {
  startTime: Date; // wall-clock reference start
}

// ---- Deterministic PRNG so cohorts are reproducible from a seed -------------

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Filler-walker name pool ------------------------------------------------
//
// Plausible German first names + a single-letter last initial. Light on the
// stereotype dial. Used until the LLM-generated personas land.

const FIRST_NAMES = [
  "Lukas", "Marie", "Tobias", "Anna", "Felix", "Leonie", "Jonas", "Hannah",
  "Maximilian", "Sophia", "Niklas", "Mia", "Florian", "Lea", "Sebastian",
  "Laura", "Christian", "Julia", "David", "Sarah", "Andreas", "Katharina",
  "Stefan", "Vanessa", "Markus", "Lisa", "Daniel", "Carolin", "Matthias",
  "Theresa", "Philipp", "Janina", "Simon", "Nina", "Benedikt", "Verena",
  "Korbinian", "Magdalena", "Alexander", "Eva", "Manuel", "Franziska",
  "Bastian", "Antonia", "Jakob", "Helena", "Moritz", "Greta", "Vincent",
  "Carla",
];

const LAST_INITIALS = "BFGHKLMRSWZ";

function fillerName(rng: () => number): string {
  const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
  const last = LAST_INITIALS[Math.floor(rng() * LAST_INITIALS.length)];
  return `${first} ${last}.`;
}

// ---- Cohort generation -------------------------------------------------------

export interface CohortConfig {
  size: number; // total walkers (real + filler)
  realWalkers: Array<{ name: string; bandId: number }>;
  startWindowMin: number; // walkers start spread over this many minutes (Megamarsch real start window is ~120 min)
  seed: number;
}

export function generateCohort(cfg: CohortConfig): Walker[] {
  const rng = mulberry32(cfg.seed);
  const walkers: Walker[] = [];

  // Real walkers first — keep their names, otherwise behave like fillers.
  for (let i = 0; i < cfg.realWalkers.length; i++) {
    const r = cfg.realWalkers[i];
    walkers.push(makeWalker(rng, `real-${i}`, r.name, r.bandId, true, cfg.startWindowMin));
  }

  // Fillers drawn from the population mix.
  const fillerCount = Math.max(0, cfg.size - cfg.realWalkers.length);
  for (let i = 0; i < fillerCount; i++) {
    const bandId = drawBand(rng);
    walkers.push(
      makeWalker(rng, `filler-${i}`, fillerName(rng), bandId, false, cfg.startWindowMin),
    );
  }

  return walkers;
}

function drawBand(rng: () => number): number {
  const r = rng();
  let acc = 0;
  for (const b of BANDS) {
    acc += b.populationShare;
    if (r < acc) return b.id;
  }
  return BANDS[BANDS.length - 1].id;
}

function makeWalker(
  rng: () => number,
  id: string,
  name: string,
  bandId: number,
  isReal: boolean,
  startWindowMin: number,
): Walker {
  const band = bandById(bandId);
  // Jitter pace_0 by ±5% so walkers in the same band aren't identical clones.
  const jitter = 1 + (rng() - 0.5) * 0.1;
  const pace0 = band.pace0 * jitter;

  // Start offset uniform across the start window.
  const startOffsetMin = rng() * startWindowMin;

  // DNF point: real walkers always finish (don't ruin the user's day),
  // fillers honor the historical hazard.
  const dnfKm = isReal ? null : rollDnfKm(rng, bandId);

  return { id, name, bandId, pace0, startOffsetMin, dnfKm, isReal };
}

// ---- Position queries -------------------------------------------------------

export type WalkerStatus = "pre-start" | "walking" | "finished" | "dnf";

export interface WalkerSnapshot {
  walker: Walker;
  status: WalkerStatus;
  km: number;
  position: [number, number];
}

/** A walker's status and km at simulation time t (hours since cohort startTime). */
export function snapshotAt(walker: Walker, route: Route, tHours: number): WalkerSnapshot {
  const personalT = tHours - walker.startOffsetMin / 60;

  if (personalT <= 0) {
    return { walker, status: "pre-start", km: 0, position: positionAtKm(route, 0) };
  }

  const naiveKm = kmAtTime(walker.pace0, personalT);

  // Has this walker DNF'd?
  if (walker.dnfKm !== null && naiveKm >= walker.dnfKm) {
    return {
      walker,
      status: "dnf",
      km: walker.dnfKm,
      position: positionAtKm(route, walker.dnfKm),
    };
  }

  // Has this walker reached the finish?
  if (naiveKm >= ROUTE_KM) {
    return { walker, status: "finished", km: ROUTE_KM, position: positionAtKm(route, ROUTE_KM) };
  }

  return { walker, status: "walking", km: naiveKm, position: positionAtKm(route, naiveKm) };
}

// ---- TripsLayer trajectory pre-computation ----------------------------------
//
// deck.gl's TripsLayer wants an array of trips, each with `path` and
// `timestamps`. Build these once at sim start; deck handles interpolation
// every frame on the GPU.

export interface Trip {
  path: Array<[number, number]>;
  timestamps: number[]; // seconds since cohort startTime
  walker: Walker;
  finishStatus: "finished" | "dnf";
  finishKm: number;
  finishTimeSec: number;
}

const ALPHA_USE = ALPHA;

export function buildTrip(walker: Walker, route: Route): Trip {
  // Use every route polyline vertex as a path sample so deck.gl's TripsLayer
  // animates exactly along the route, not in straight-line shortcuts between
  // arbitrary km checkpoints. The model still drives WHEN the walker is at
  // each point — we just hand the GPU the route's actual geometry.
  const endKm = walker.dnfKm ?? ROUTE_KM;
  const startSec = walker.startOffsetMin * 60;

  const path: Array<[number, number]> = [];
  const timestamps: number[] = [];

  for (const p of route.points) {
    if (p.cumKm > endKm) break;
    path.push([p.lon, p.lat]);
    timestamps.push(startSec + timeAtKm(walker.pace0, p.cumKm) * 3600);
  }

  // Append the precise endpoint (DNF spot or finish line) interpolated between
  // route vertices, so the walker's last position lands exactly there.
  const endPos = positionAtKm(route, endKm);
  if (
    path.length === 0 ||
    path[path.length - 1][0] !== endPos[0] ||
    path[path.length - 1][1] !== endPos[1]
  ) {
    path.push(endPos);
    timestamps.push(startSec + timeAtKm(walker.pace0, endKm) * 3600);
  }

  return {
    walker,
    path,
    timestamps,
    finishStatus: walker.dnfKm == null ? "finished" : "dnf",
    finishKm: endKm,
    finishTimeSec: timestamps[timestamps.length - 1],
  };
}

export function buildAllTrips(walkers: Walker[], route: Route): Trip[] {
  // The model breaks down at d > ROUTE_KM/α; we never sample there.
  void ALPHA_USE; // keep import live, used implicitly via timeAtKm
  return walkers.map((w) => buildTrip(w, route));
}

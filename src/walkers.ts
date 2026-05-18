// Walker generation.
//
// A cohort = a fixed list of immutable walker definitions. Every walker is just
// a tuple of (name, band, pace_0 with jitter, start_offset, dnf_km). Their
// position at time t is a pure function — no state to update.

import {
  ALPHA,
  BANDS,
  REST_MINUTES,
  ROUTE_KM,
  WAVE_BIAS,
  bandById,
  bandFinishProbability,
  kmAtTime,
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
  startWindowMin: number; // total start window in minutes
  waveCount: number; // number of discrete waves in the start window
  seed: number;
  checkpointKm: number[]; // VPS checkpoint cumulative km positions (for DNF logic)
}

export function generateCohort(cfg: CohortConfig): Walker[] {
  const rng = mulberry32(cfg.seed);
  const walkers: Walker[] = [];

  // Real walkers first — keep their names, otherwise behave like fillers.
  for (let i = 0; i < cfg.realWalkers.length; i++) {
    const r = cfg.realWalkers[i];
    walkers.push(makeWalker(rng, `real-${i}`, r.name, r.bandId, true, cfg.startWindowMin, cfg.waveCount, cfg.checkpointKm));
  }

  // Fillers drawn from the population mix.
  const fillerCount = Math.max(0, cfg.size - cfg.realWalkers.length);
  for (let i = 0; i < fillerCount; i++) {
    const bandId = drawBand(rng);
    walkers.push(
      makeWalker(rng, `filler-${i}`, fillerName(rng), bandId, false, cfg.startWindowMin, cfg.waveCount, cfg.checkpointKm),
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
  waveCount: number,
  checkpointKm: number[],
): Walker {
  const band = bandById(bandId);
  // Jitter pace_0 by ±5% so walkers in the same band aren't identical clones.
  const jitter = 1 + (rng() - 0.5) * 0.1;
  const pace0 = band.pace0 * jitter;

  // Wave start: faster bands bias to earlier waves, slower to later.
  // Add small jitter (±3 min) so walkers don't start at exactly the same second.
  const bias = WAVE_BIAS[bandId] ?? 0;
  const raw = rng() + bias;
  const waveIndex = Math.floor(
    Math.max(0, Math.min(waveCount - 1, raw * waveCount)),
  );
  const waveCenter = (waveIndex / (waveCount - 1 || 1)) * startWindowMin;
  const startOffsetMin = waveCenter + (rng() - 0.5) * 6;

  // DNF point: real walkers always finish. For fillers, most DNFs happen at
  // checkpoints (VPS stations) where bail-out transport is available.
  // During the night section, there's no bail option — people push to the
  // next checkpoint.
  const dnfKm = isReal ? null : rollDnfCheckpoint(rng, bandId, checkpointKm);

  return { id, name, bandId, pace0, startOffsetMin, dnfKm, isReal };
}

/**
 * Roll a DNF at a checkpoint (VPS station), not a random km.
 *
 * Most walkers who quit do so at a checkpoint where transport is available.
 * VPS3 (indoor, shuttle bus) is the biggest dropout point.
 * During the night section, bail-out options are scarce — people push through
 * to the next open checkpoint.
 *
 * ~5% of DNFs are random mid-route (injury, heatstroke, blisters so bad
 * they can't continue even to the next station).
 */
function rollDnfCheckpoint(
  rng: () => number,
  bandId: number,
  checkpoints: number[],
): number | null {
  if (rng() < bandFinishProbability(bandId)) return null;

  // Sort checkpoints and filter to valid range.
  const cps = [...checkpoints].sort((a, b) => a - b).filter((km) => km > 0 && km < ROUTE_KM);
  if (cps.length === 0) return null;

  // VPS3 (the indoor checkpoint with shuttle) is typically the 3rd or 4th.
  // We weight checkpoints: later ones get higher DNF probability.
  // Index 2 (third checkpoint, ~VPS3) gets highest weight.
  const weights = cps.map((_, i) => {
    if (i === 2) return 5;  // VPS3 — indoor, shuttle bus, highest dropout
    if (i === 3) return 3;  // VPS4 — late dropout, tired
    if (i === 1) return 2;  // VPS2 — night approaching
    return 1;                // VPS1, Zwischenstation — early dropout (rare)
  });

  // ~5% chance of random mid-route DNF (non-checkpoint).
  if (rng() < 0.05) {
    // Pick a point between checkpoints, biased toward later segments.
    const cpIdx = weightedPick(rng, weights);
    const start = cpIdx === 0 ? 5 : cps[cpIdx - 1];
    const end = cps[cpIdx];
    return start + rng() * (end - start);
  }

  // Normal case: DNF at a checkpoint.
  const cpIdx = weightedPick(rng, weights);
  // Small jitter around the checkpoint (±1 km).
  return cps[cpIdx] + (rng() - 0.5) * 2;
}

/** Weighted random pick from an array of weights. */
function weightedPick(rng: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
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

/** String hash for deterministic noise seeding per walker. */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

/** Box-Muller: Gaussian random from uniform [0,1). */
function boxMuller(rng: () => number): number {
  const u1 = Math.max(0.0001, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Band-specific noise params for realistic pace variation.
 * Calibrated to real 2026 participant GPS data.
 */
const BAND_NOISE: Record<number, {
  sigma: number; theta: number; microRestProb: number;
  microRestMeanSec: number; endSpurtBoost: number;
}> = {
  0: { sigma: 2.0, theta: 0.08, microRestProb: 0.06, microRestMeanSec: 180, endSpurtBoost: 1.00 },
  1: { sigma: 1.5, theta: 0.07, microRestProb: 0.04, microRestMeanSec: 150, endSpurtBoost: 1.03 },
  2: { sigma: 1.2, theta: 0.06, microRestProb: 0.03, microRestMeanSec: 120, endSpurtBoost: 1.05 },
  3: { sigma: 0.9, theta: 0.05, microRestProb: 0.02, microRestMeanSec: 90,  endSpurtBoost: 1.08 },
  4: { sigma: 0.6, theta: 0.04, microRestProb: 0.015,microRestMeanSec: 60,  endSpurtBoost: 1.10 },
  5: { sigma: 0.4, theta: 0.03, microRestProb: 0.01, microRestMeanSec: 40,  endSpurtBoost: 1.15 },
};

/**
 * Generate timestamps with realistic pace noise (Ornstein-Uhlenbeck),
 * random micro-rests, end-spurt boost, and checkpoint stops.
 * Also applies terrain (slope), time-of-day, and weather modifiers.
 */
function buildNoisyTimestamps(
  pace0: number,
  routePoints: Array<{ lon: number; lat: number; cumKm: number; ele: number; slope: number }>,
  endKm: number,
  rng: () => number,
  noise: typeof BAND_NOISE[number],
  restStops: number[] | null,
  cps: Array<{ cumKm: number }>,
  startSec: number, // sim-seconds since event start (for time-of-day)
): number[] {
  const ts: number[] = [];
  let ou = 0;
  let restSec = 0;
  const doneCPs = new Set<number>();

  // Pre-generate micro-rests (random short pauses).
  const microRests: Array<{ km: number; dur: number }> = [];
  for (let km = 0; km < endKm - 3; km += 0.5) {
    if (rng() < noise.microRestProb * 0.5) {
      microRests.push({
        km: km + rng() * 0.4,
        dur: -Math.log(Math.max(0.001, rng())) * noise.microRestMeanSec,
      });
    }
  }
  microRests.sort((a, b) => a.km - b.km);
  let mrIdx = 0;
  let prevKm = 0;

  for (const p of routePoints) {
    if (p.cumKm > endKm) break;

    // Checkpoint rest stops.
    if (restStops) {
      for (let ci = 0; ci < cps.length; ci++) {
        if (p.cumKm >= cps[ci].cumKm && !doneCPs.has(ci)) {
          doneCPs.add(ci);
          restSec += (restStops[ci] ?? restStops[restStops.length - 1]) * 60;
        }
      }
    }

    // Micro-rests passed since last point.
    while (mrIdx < microRests.length && microRests[mrIdx].km <= p.cumKm) {
      restSec += microRests[mrIdx].dur;
      mrIdx++;
    }

    // Smooth time.
    const smoothH = timeAtKm(pace0, p.cumKm);

    // End-spurt boost in final 10km.
    let effPace = pace0;
    if (p.cumKm > endKm - 10) effPace *= noise.endSpurtBoost;

    // ---- Environmental modifiers ------------------------------------------
    let envMult = 1.0;

    // Slope: uphill slows, downhill speeds up (but not too much).
    const slope = p.slope ?? 0;
    if (slope > 0.05) envMult -= Math.min(0.25, slope * 3);      // steep uphill
    else if (slope > 0.02) envMult -= slope * 1.5;               // gentle uphill
    else if (slope < -0.05) envMult += Math.min(0.15, -slope);   // steep downhill

    // Time of day: night slowdown (20:00–06:00).
    // Event starts at 12:00 CEST (noon).
    const hour = (12 + startSec / 3600 + smoothH) % 24;
    if (hour >= 20 || hour < 6) envMult -= 0.10;
    // Deep night (00:00–04:00): extra cold + fatigue.
    if (hour >= 0 && hour < 4) envMult -= 0.05;

    // Weather: rain during first 8 hours of event (noon–8pm Saturday).
    const eventHour = smoothH; // hours since track start
    if (eventHour < 8) envMult -= 0.05; // drizzle/rain

    // Checkpoint anticipation: speed up in last 2 km before a CP.
    for (const cp of cps) {
      if (p.cumKm < cp.cumKm && p.cumKm > cp.cumKm - 2) {
        envMult += 0.05;
        break;
      }
    }

    // Post-checkpoint recovery: slower for 1.5 km after leaving a CP.
    for (const cp of cps) {
      if (p.cumKm > cp.cumKm && p.cumKm < cp.cumKm + 1.5) {
        envMult -= 0.08;
        break;
      }
    }

    // The wall (km 70–85): fatigue peak.
    if (p.cumKm > 70 && p.cumKm < 85) envMult -= 0.08;

    effPace *= Math.max(0.5, envMult);

    // ---- Ornstein-Uhlenbeck pace noise ------------------------------------
    const dKm = p.cumKm - prevKm;
    if (dKm > 0.001 && dKm < 1) {
      const e = Math.exp(-noise.theta * dKm);
      ou = ou * e + noise.sigma * Math.sqrt(1 - e * e) * boxMuller(rng);
    }
    prevKm = p.cumKm;

    const noisyPace = Math.max(2.0, Math.min(8.0, effPace + ou));
    // Blend smooth and noisy: scale smooth time by pace ratio.
    const adjustedH = smoothH * (pace0 / noisyPace);
    ts.push(adjustedH * 3600 + restSec);
  }

  return ts;
}

export function buildTrip(walker: Walker, route: Route): Trip {
  // Use every route polyline vertex as a path sample so deck.gl's TripsLayer
  // animates exactly along the route, not in straight-line shortcuts between
  // arbitrary km checkpoints. The model still drives WHEN the walker is at
  // each point — we just hand the GPU the route's actual geometry.
  const endKm = walker.dnfKm ?? ROUTE_KM;
  const startSec = walker.startOffsetMin * 60;

  // Rest stops: walkers pause at checkpoints. Schlussläufer/Vorläufer don't rest.
  const restStops = walker.bandId >= 0 ? REST_MINUTES[walker.bandId] : null;
  const cps = [...route.waypoints]
    .sort((a, b) => a.cumKm - b.cumKm)
    .filter((wp) => wp.cumKm > 0 && wp.cumKm < endKm);

  const path: Array<[number, number]> = [];
  let timestamps: number[];

  // Use noisy timestamps for regular walkers; smooth for Schluss/Vor.
  if (walker.bandId >= 0) {
    const noiseRng = mulberry32(hashStr(walker.id));
    const n = BAND_NOISE[walker.bandId] ?? BAND_NOISE[2];
    timestamps = buildNoisyTimestamps(
      walker.pace0, route.points, endKm, noiseRng, n, restStops, cps,
      startSec, // used for time-of-day calculation
    ).map((t) => t + startSec);
  } else {
    timestamps = [];
    for (const p of route.points) {
      if (p.cumKm > endKm) break;
      timestamps.push(startSec + timeAtKm(walker.pace0, p.cumKm) * 3600);
    }
  }

  for (const p of route.points) {
    if (p.cumKm > endKm) break;
    path.push([p.lon, p.lat]);
  }

  // Append the precise endpoint (DNF spot or finish line) interpolated between
  // route vertices, so the walker's last position lands exactly there.
  // For noisy walkers, compute total rests to keep the endpoint consistent.
  const endPos = positionAtKm(route, endKm);
  if (
    path.length === 0 ||
    path[path.length - 1][0] !== endPos[0] ||
    path[path.length - 1][1] !== endPos[1]
  ) {
    path.push(endPos);
    const endSmooth = startSec + timeAtKm(walker.pace0, endKm) * 3600;
    if (walker.bandId >= 0 && timestamps.length > 0) {
      // Carry forward the noise/rest offset from the last point.
      const lastKm = route.points.find((rp) =>
        rp.lon === path[path.length - 2]?.[0] && rp.lat === path[path.length - 2]?.[1]
      )?.cumKm ?? endKm - 0.1;
      const lastSmooth = startSec + timeAtKm(walker.pace0, lastKm) * 3600;
      const drift = timestamps[timestamps.length - 1] - lastSmooth;
      timestamps.push(endSmooth + drift);
    } else {
      timestamps.push(endSmooth);
    }
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

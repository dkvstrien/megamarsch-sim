// Pace decay model for the Megamarsch München 100 km hike.
//
// Calibrated to the official handbook (4.2–6.0 km/h average including breaks)
// and real 2026 participant data (author: 4.44 km/h effective, 23h01m finish).
//
// pace(d) = pace_0 · (1 − α · d/100)        linear decay over the route
// α = 0.30 fits four real Munich finishers (2019, 2022, 2024 + t-online journalist)
// to within ~20 minutes everywhere they reported a split.
//
// Closed-form time at distance d:
//   T(d) = (100 / (pace_0 · α)) · ln(1 / (1 − α · d/100))
//
// Target finish time at a given effective average speed:
//   pace_0 ≈ 118.9 / target_hours

export const ALPHA = 0.3;

/** Actual 2026 Munich route distance from GPS data (Igor: 109.7, Chid: 106.0, Dan: 102.1). */
export const ROUTE_KM = 105;

/** Soft cutoff for sim: 36 hours ensures even slow finishers complete. */
export const CUTOFF_HOURS = 36;

/** Official minimum average speed (handbook). Schlussläufer maintains this. */
export const SCHLUSSLAEUFER_PACE = 4.2;

/** Official maximum average speed (handbook). Vorläufer maintains this. */
export const VORLAEUFER_PACE = 6.0;

/**
 * Rest stop durations in minutes per band at each VPS checkpoint.
 * Index 0 = VPS1, 1 = VPS2, 2 = VPS3 (indoor, shuttle bus — longest stops),
 * 3 = VPS4. Schlussläufer and Vorläufer take zero rest.
 */
export const REST_MINUTES: Record<number, number[]> = {
  0: [25, 25, 35, 25], // Beginner: long breaks, VPS3 is a proper rest
  1: [20, 20, 30, 20], // Comfortable
  2: [15, 15, 25, 15], // Steady
  3: [10, 10, 20, 10], // Strong
  4: [5, 8, 10, 5],    // Fast: short breaks
  5: [3, 5, 5, 3],     // Elite: grab food and go
};

/**
 * Wave bias per band. Negative = earlier waves, positive = later waves.
 * Elite/Fast start early, Beginner/Comfortable sleep in.
 */
export const WAVE_BIAS: Record<number, number> = {
  5: -0.40, // Elite: heavily early
  4: -0.25, // Fast: early
  3: -0.10, // Strong: slight early bias
  2: 0.00,  // Steady: uniform
  1: 0.15,  // Comfortable: later
  0: 0.30,  // Beginner: heavily later
};

/**
 * Schlussläufer pace_0 to produce exactly 4.2 km/h average over 105 km.
 * pace_0 = 124.8 / 25.0 = 4.99 → round to 5.0
 */
export const SCHLUSSLAEUFER_PACE0 = 5.0;

/**
 * Vorläufer pace_0 to produce exactly 6.0 km/h average over 105 km.
 * pace_0 = 124.8 / 17.5 = 7.13 → round to 7.1
 */
export const VORLAEUFER_PACE0 = 7.1;

export interface Band {
  id: number;
  label: string;
  blurb: string;
  pace0: number; // km/h at km 0
  populationShare: number; // fraction of filler walkers in this band
}

/**
 * Six fitness bands, calibrated to the 2026 Munich event.
 *
 * Population is a bell curve centered on Steady (band 2).
 * The Schlussläufer catches walkers whose average pace falls below 4.2 km/h;
 * Beginner band walkers (3.8 km/h target) will get caught.
 */
export const BANDS: Band[] = [
  {
    id: 0,
    label: "Beginner",
    blurb: "First long-distance event. Can't hold 4.2 km/h — gets caught by the sweeper.",
    pace0: 4.7,
    populationShare: 0.10,
  },
  {
    id: 1,
    label: "Comfortable",
    blurb: "Walks fit. Aiming to finish, breaks at every VPS. Borderline cutoff.",
    pace0: 5.4,
    populationShare: 0.20,
  },
  {
    id: 2,
    label: "Steady",
    blurb: "Some training, a 50 km in the legs. Finishes around 21–24h.",
    pace0: 5.9,
    populationShare: 0.30,
  },
  {
    id: 3,
    label: "Strong",
    blurb: "Regular hiker, steady through the night, sub-20h finish.",
    pace0: 6.4,
    populationShare: 0.22,
  },
  {
    id: 4,
    label: "Fast",
    blurb: "Trains long. Front of the field, brief VPS stops.",
    pace0: 6.8,
    populationShare: 0.13,
  },
  {
    id: 5,
    label: "Elite",
    blurb: "Top finisher. Fast pace, minimal breaks. Sub-17h. (Igor: 16.7h)",
    pace0: 7.5,
    populationShare: 0.05,
  },
];

export function bandById(id: number): Band {
  const b = BANDS.find((b) => b.id === id);
  if (!b) throw new Error(`unknown band ${id}`);
  return b;
}

/** Hours elapsed at km d, given a starting pace and the global α. */
export function timeAtKm(pace0: number, d: number): number {
  if (d <= 0) return 0;
  if (d >= ROUTE_KM / ALPHA) return Infinity;
  return (ROUTE_KM / (pace0 * ALPHA)) * Math.log(1 / (1 - (ALPHA * d) / ROUTE_KM));
}

/** Inverse of timeAtKm: distance covered after t hours of walking. */
export function kmAtTime(pace0: number, t: number): number {
  if (t <= 0) return 0;
  return (ROUTE_KM / ALPHA) * (1 - Math.exp((-t * pace0 * ALPHA) / ROUTE_KM));
}

/** Total finish time (hours) for a flat 100 km. */
export function flatFinishTime(pace0: number): number {
  return timeAtKm(pace0, ROUTE_KM);
}

// ---- DNF hazard ---------------------------------------------------------------
//
// DNFs cluster in km 55–80 (Walchensee, the long night, sore feet).
// Beginner band: very high DNF rate (caught by Schlussläufer or quit).
// Overall finish rate targets ~40% (typical for 100 km events).
//
// The Schlussläufer mechanic also catches walkers who fall below the official
// minimum pace — these become de-facto DNFs even if they haven't technically
// dropped yet.

const BAND_FINISH_PROB: Record<number, number> = {
  0: 0.05, // Beginner: almost all get caught or drop out
  1: 0.25, // Comfortable: many DNF in the 55–80 km danger zone
  2: 0.50, // Steady: half finish
  3: 0.72, // Strong: most finish
  4: 0.85, // Fast: very few DNF
  5: 0.95, // Elite: nearly all finish
};

/**
 * Weighted average finish probability.
 *   0.10·0.05 + 0.20·0.25 + 0.30·0.50 + 0.22·0.72 + 0.13·0.85 + 0.05·0.95
 *   = 0.005 + 0.050 + 0.150 + 0.158 + 0.111 + 0.048
 *   = 0.522
 * Higher than the old 37% — the cutoff extension to 28h and the Schlussläufer
 * mechanic will bring this down in practice.
 */
export function expectedFinishRate(): number {
  return BANDS.reduce(
    (s, b) => s + b.populationShare * BAND_FINISH_PROB[b.id],
    0,
  );
}

export function bandFinishProbability(bandId: number): number {
  return BAND_FINISH_PROB[bandId] ?? 0.4;
}

/**
 * Roll a DNF point in km, biased toward 55–80. Returns null if the walker
 * finishes. Uses a triangular-ish bias by sampling x = 0.55 + 0.30·u² where
 * u ∈ [-1, 1] is symmetric around 0; clamped to [0.10, 0.95] to allow rare
 * early and late DNFs.
 */
export function rollDnfKm(rng: () => number, bandId: number): number | null {
  if (rng() < (BAND_FINISH_PROB[bandId] ?? 0.4)) return null;
  const u = rng() * 2 - 1; // [-1, 1]
  const center = 0.55 + 0.3 * u * u; // [0.55, 0.85] biased toward 0.55
  const jitter = (rng() - 0.5) * 0.2; // ± 0.10
  const frac = Math.min(0.97, Math.max(0.08, center + jitter));
  return frac * ROUTE_KM;
}

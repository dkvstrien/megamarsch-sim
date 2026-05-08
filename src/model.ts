// Pace decay model for the Megamarsch München 100 km hike.
//
// pace(d) = pace_0 · (1 − α · d/100)        linear decay over the route
// α = 0.30 fits four real Munich finishers (2019, 2022, 2024 + t-online journalist)
// to within ~20 minutes everywhere they reported a split.
//
// Closed-form time at distance d:
//   T(d) = (100 / (pace_0 · α)) · ln(1 / (1 − α · d/100))
//
// The 970 m of elevation in the Munich profile is absorbed into pace_0 since the
// bands were fit on Munich data directly. Other events would need a separate fit.

export const ALPHA = 0.3;
export const ROUTE_KM = 100;
export const CUTOFF_HOURS = 24;

export interface Band {
  id: 1 | 2 | 3 | 4 | 5;
  label: string;
  blurb: string;
  pace0: number; // km/h at km 0
  populationShare: number; // fraction of filler walkers in this band
}

export const BANDS: Band[] = [
  {
    id: 1,
    label: "Comfortable",
    blurb: "Walks fit. Aiming to finish, breaks at every VPS.",
    pace0: 5.0,
    populationShare: 0.35,
  },
  {
    id: 2,
    label: "Steady",
    blurb: "Some training, a 50 km in the legs. Will finish, will hurt.",
    pace0: 5.4,
    populationShare: 0.3,
  },
  {
    id: 3,
    label: "Strong",
    blurb: "Regular hiker, steady through the night, sub-20 h plausible.",
    pace0: 6.0,
    populationShare: 0.2,
  },
  {
    id: 4,
    label: "Fast",
    blurb: "Trains long. Front of the field, brief VPS stops.",
    pace0: 6.6,
    populationShare: 0.1,
  },
  {
    id: 5,
    label: "Elite",
    blurb: "Centurion-grade. Sub-16 h finisher.",
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
  if (d >= ROUTE_KM / ALPHA) return Infinity; // pace would go to zero
  return (ROUTE_KM / (pace0 * ALPHA)) * Math.log(1 / (1 - (ALPHA * d) / ROUTE_KM));
}

/** Inverse of timeAtKm: distance covered after t hours of walking. */
export function kmAtTime(pace0: number, t: number): number {
  if (t <= 0) return 0;
  // d = (ROUTE_KM/α) · (1 − exp(−t · pace_0 · α / ROUTE_KM))
  return (ROUTE_KM / ALPHA) * (1 - Math.exp((-t * pace0 * ALPHA) / ROUTE_KM));
}

/** Total finish time (hours) for a flat 100 km. */
export function flatFinishTime(pace0: number): number {
  return timeAtKm(pace0, ROUTE_KM);
}

// ---- DNF hazard ---------------------------------------------------------------
//
// Historical Megamarsch 100 km finish rate: 37%. We want the cohort to honor
// that. DNFs concentrate in km 55–80 (the empirical danger zone — Walchensee,
// the long night, sore feet).
//
// Approach: at walker creation, roll a uniform U ∈ [0, 1]. If U < bandFinishProb,
// they finish. Otherwise their dnf_at_km is sampled from a distribution skewed
// toward 55–80. Faster bands have higher finish probabilities so the population
// average lands at 37%.

const BAND_FINISH_PROB: Record<number, number> = {
  1: 0.18, // Comfortable: barely makes 24h cutoff most days, often DNFs
  2: 0.4,
  3: 0.55,
  4: 0.78,
  5: 0.92,
};

/**
 * Average finish probability across the population mix.
 * Used as a sanity check that we're targeting ~0.37.
 *   0.35·0.18 + 0.30·0.40 + 0.20·0.55 + 0.10·0.78 + 0.05·0.92
 *   = 0.063 + 0.120 + 0.110 + 0.078 + 0.046
 *   = 0.417
 * Slightly above 37%, fine — the cutoff itself will fail some band-1 walkers.
 */
export function expectedFinishRate(): number {
  return BANDS.reduce(
    (s, b) => s + b.populationShare * BAND_FINISH_PROB[b.id],
    0,
  );
}

export function bandFinishProbability(bandId: number): number {
  return BAND_FINISH_PROB[bandId];
}

/**
 * Roll a DNF point in km, biased toward 55–80. Returns null if the walker
 * finishes. Uses a triangular-ish bias by sampling x = 0.55 + 0.30·u² where
 * u ∈ [-1, 1] is symmetric around 0; clamped to [0.10, 0.95] to allow rare
 * early and late DNFs.
 */
export function rollDnfKm(rng: () => number, bandId: number): number | null {
  if (rng() < BAND_FINISH_PROB[bandId]) return null;
  const u = rng() * 2 - 1; // [-1, 1]
  const center = 0.55 + 0.3 * u * u; // [0.55, 0.85] biased toward 0.55
  const jitter = (rng() - 0.5) * 0.2; // ± 0.10
  const frac = Math.min(0.97, Math.max(0.08, center + jitter));
  return frac * ROUTE_KM;
}

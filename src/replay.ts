// Replay-track module.
//
// Parses user-uploaded GPX files (real Strava/watch recordings from the event)
// and converts them into deck.gl TripsLayer-compatible data. Supports two
// alignment modes so you can compare friends side-by-side or see how people
// started at different times relative to each other.

// ---- Types ------------------------------------------------------------------

/** A single trackpoint extracted from a GPX file. */
interface GpxPoint {
  lon: number;
  lat: number;
  time: Date;
}

/** A fully-parsed replay track, ready for the layer. */
export interface ReplayTrack {
  id: string;
  name: string; // filename without extension (user-editable)
  path: Array<[number, number]>; // [lon, lat] per trackpoint
  timestamps: number[]; // seconds since this track's first point
  distances: number[]; // cumulative km at each point
  totalKm: number;
  durationSec: number;
  startEpochMs: number; // absolute epoch ms of the first trackpoint
  colorIndex: number;
  customColor: [number, number, number] | null; // user-picked override
}

/** The object passed to deck.gl TripsLayer. */
export interface ReplayTripData {
  path: Array<[number, number]>;
  timestamps: number[];
  color: [number, number, number];
  track: ReplayTrack;
}

/** Alignment modes for replay. */
export type ReplayMode = "side-by-side" | "time-aligned";

/**
 * Official Megamarsch München 2026 event start epoch.
 * May 16, 2026 10:00 UTC = 12:00 CEST (noon, first start wave).
 */
export const EVENT_START_EPOCH = Date.UTC(2026, 4, 16, 10, 0, 0);

// ---- Color palette ---------------------------------------------------------

const REPLAY_COLORS: Array<[number, number, number]> = [
  [255, 99, 132],   // hot pink
  [54, 162, 235],   // bright blue
  [255, 206, 86],   // yellow
  [75, 192, 192],   // teal
  [153, 102, 255],  // purple
  [255, 159, 64],   // orange
  [46, 204, 113],   // emerald green
  [231, 76, 60],    // red
  [52, 152, 219],   // sky blue
  [155, 89, 182],   // violet
  [241, 196, 15],   // gold
  [26, 188, 156],   // turquoise
];

const REPLAY_EMOJI = [
  "🏃", "🚶‍♀️", "🏃‍♂️", "🚶", "🏃‍♀️",
  "🥾", "🎒", "⛰️", "💪", "🦿",
  "🔥", "⚡",
];

export function replayColor(idx: number): [number, number, number] {
  return REPLAY_COLORS[idx % REPLAY_COLORS.length];
}

export function replayEmoji(idx: number): string {
  return REPLAY_EMOJI[idx % REPLAY_EMOJI.length];
}

// ---- GPX parsing -----------------------------------------------------------

/** Haversine distance in km between two [lon, lat] pairs. */
function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Parse a user-uploaded GPX file into a ReplayTrack.
 *
 * Throws if the file can't be parsed or has fewer than 2 trackpoints
 * with timestamps.
 */
export async function parseGpxFile(
  file: File,
  colorIndex: number,
): Promise<ReplayTrack> {
  const text = await file.text();
  const xml = new DOMParser().parseFromString(text, "application/xml");

  const parseError = xml.querySelector("parsererror");
  if (parseError) {
    throw new Error(`GPX parse error: ${parseError.textContent ?? "unknown"}`);
  }

  // GPX can use <trkpt> with or without XML namespace. getElementsByTagName
  // is namespace-insensitive in practice.
  const trkptEls = xml.getElementsByTagName("trkpt");
  if (trkptEls.length === 0) {
    throw new Error("No <trkpt> elements found in GPX file.");
  }

  const points: GpxPoint[] = [];
  for (let i = 0; i < trkptEls.length; i++) {
    const pt = trkptEls[i];
    const lat = parseFloat(pt.getAttribute("lat") ?? "");
    const lon = parseFloat(pt.getAttribute("lon") ?? "");
    if (isNaN(lat) || isNaN(lon)) continue;

    const timeEl = pt.getElementsByTagName("time")[0];
    if (!timeEl || !timeEl.textContent) continue;
    const time = new Date(timeEl.textContent);
    if (isNaN(time.getTime())) continue;

    points.push({ lon, lat, time });
  }

  if (points.length < 2) {
    // No timestamps — Strava export workaround.
    // Estimate timestamps assuming a default 5 km/h pace.
    const estPace = 5.0; // km/h
    const rawPoints: Array<{ lon: number; lat: number }> = [];
    for (let i = 0; i < trkptEls.length; i++) {
      const pt = trkptEls[i];
      const lat = parseFloat(pt.getAttribute("lat") ?? "");
      const lon = parseFloat(pt.getAttribute("lon") ?? "");
      if (!isNaN(lat) && !isNaN(lon)) rawPoints.push({ lon, lat });
    }
    if (rawPoints.length < 2) {
      throw new Error("No valid trackpoints found in GPX file.");
    }

    // Build path and estimate timestamps from cumulative distance.
    const path: Array<[number, number]> = [];
    const timestamps: number[] = [];
    const distances: number[] = [];
    let cumKm = 0;
    path.push([rawPoints[0].lon, rawPoints[0].lat]);
    timestamps.push(0);
    distances.push(0);
    for (let i = 1; i < rawPoints.length; i++) {
      path.push([rawPoints[i].lon, rawPoints[i].lat]);
      cumKm += haversineKm(
        [rawPoints[i - 1].lon, rawPoints[i - 1].lat],
        [rawPoints[i].lon, rawPoints[i].lat],
      );
      timestamps.push((cumKm / estPace) * 3600);
      distances.push(cumKm);
    }

    const name = file.name.replace(/\.(gpx|xml)(\.txt)?$/i, "");
    return {
      id: `replay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name + " (est.)",
      path,
      timestamps,
      distances,
      totalKm: cumKm,
      durationSec: timestamps[timestamps.length - 1],
      startEpochMs: 0,
      colorIndex,
      customColor: null,
    };
  }

  // Strava exports sometimes have points out of time-order.
  points.sort((a, b) => a.time.getTime() - b.time.getTime());

  const startEpochMs = points[0].time.getTime();

  const path: Array<[number, number]> = [];
  const timestamps: number[] = [];
  const distances: number[] = [];
  let cumKm = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    path.push([p.lon, p.lat]);
    timestamps.push((p.time.getTime() - startEpochMs) / 1000);

    if (i > 0) {
      cumKm += haversineKm(
        [points[i - 1].lon, points[i - 1].lat],
        [p.lon, p.lat],
      );
    }
    distances.push(cumKm);
  }

  const durationSec = timestamps[timestamps.length - 1];

  // Name from filename, strip extension(s).
  // "Run-20260516-1426-60837.gpx.txt" → "Run-20260516-1426-60837"
  const name = file.name.replace(/\.(gpx|xml)(\.txt)?$/i, "");

  return {
    id: `replay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    path,
    timestamps,
    distances,
    totalKm: cumKm,
    durationSec,
    startEpochMs,
    colorIndex,
    customColor: null,
  };
}

// ---- Trip building ---------------------------------------------------------

/**
 * Fill in the gap between the route start and the first GPX trackpoint
 * using the route geometry and the walker's estimated pace.
 *
 * Many GPS recordings start a few blocks or kilometers into the route
 * (e.g., recording started late, GPS lock delay). Without this, the
 * replay track starts already partway down the route, misaligned with
 * the event timeline.
 */
export function fillMissingRoutePrefix(
  track: ReplayTrack,
  routePoints: Array<{ lon: number; lat: number; cumKm: number }>,
  positionAtKmFn: (km: number) => [number, number],
): ReplayTrack {
  // Find nearest route point to the first GPX trackpoint.
  const firstPt = track.path[0];
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < routePoints.length; i++) {
    const d = haversineKm(
      [firstPt[0], firstPt[1]],
      [routePoints[i].lon, routePoints[i].lat],
    );
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  const matchKm = routePoints[bestIdx].cumKm;
  // Only fill if we're missing more than ~500m.
  if (matchKm < 0.5) return track;

  // Estimate the walker's pace from early real data (first ~15 min).
  const sampleEndSec = Math.min(900, track.durationSec);
  let sampleKm = 0;
  for (let i = 1; i < track.timestamps.length; i++) {
    if (track.timestamps[i] > sampleEndSec) break;
    sampleKm = track.distances[i];
  }
  // Add the distance from route start to first GPX point.
  sampleKm += matchKm;
  const estPace = sampleKm / (sampleEndSec / 3600); // km/h
  const pace = Math.max(3.5, Math.min(7.0, estPace)); // clamp to sane range

  // Generate prefix: sample route points from km 0 to matchKm.
  const prefixPath: Array<[number, number]> = [];
  const prefixTimestamps: number[] = [];
  const prefixDistances: number[] = [];

  const firstRealTimeSec = track.timestamps[0]; // seconds from track start
  // Time from start to matchKm at estimated pace.
  const timeToMatch = (matchKm / pace) * 3600;
  // Offset: how many seconds BEFORE the first real point the route start was.
  const prefixOffset = firstRealTimeSec - timeToMatch;

  // Step through route points at ~50m intervals.
  const stepKm = 0.05;
  for (let km = 0; km <= matchKm; km += stepKm) {
    const pos = positionAtKmFn(km);
    prefixPath.push(pos);
    const t = (km / pace) * 3600 + prefixOffset;
    prefixTimestamps.push(t);
    prefixDistances.push(km);
  }

  // Ensure the last prefix point connects to the first real point.
  const lastPrefix = prefixPath[prefixPath.length - 1];
  if (
    haversineKm(lastPrefix, firstPt) > 0.1 &&
    prefixPath.length > 0
  ) {
    prefixPath.push(firstPt);
    prefixTimestamps.push(firstRealTimeSec);
    prefixDistances.push(matchKm + track.distances[0]);
  }

  // Merge: prefix starts at time 0 (km 0), real data starts at timeToMatch.
  const mergedPath = [...prefixPath, ...track.path];
  const mergedTimestamps = [
    // Prefix timestamps shifted so km 0 = time 0.
    ...prefixTimestamps.map((t) => t - prefixOffset),
    // Real data: starts after the prefix ends.
    ...track.timestamps.map((t) => t + timeToMatch),
  ];
  // Recalculate total.
  let totalKm = 0;
  for (let i = 1; i < mergedPath.length; i++) {
    totalKm += haversineKm(mergedPath[i - 1], mergedPath[i]);
  }

  // Recalculate distances from haversine (more accurate than adding matchKm).
  const recalcDist: number[] = [0];
  let cum = 0;
  for (let i = 1; i < mergedPath.length; i++) {
    cum += haversineKm(mergedPath[i - 1], mergedPath[i]);
    recalcDist.push(cum);
  }

  // Adjust startEpochMs: the track actually started at km 0, not at the
  // first recorded point. Back-date by the time it took to walk the prefix.
  const adjustedStartEpochMs =
    track.startEpochMs - Math.round(timeToMatch * 1000);

  return {
    ...track,
    path: mergedPath,
    timestamps: mergedTimestamps,
    distances: recalcDist,
    totalKm,
    startEpochMs: adjustedStartEpochMs,
    durationSec:
      mergedTimestamps[mergedTimestamps.length - 1] - mergedTimestamps[0],
  };
}

/**
 * Extend a GPX track that stops before the finish line by synthesizing
 * the remaining distance along the route at the walker's recent pace.
 */
export function fillMissingRouteSuffix(
  track: ReplayTrack,
  _routePoints: Array<{ lon: number; lat: number; cumKm: number }>,
  positionAtKmFn: (km: number) => [number, number],
  routeTotalKm: number,
): ReplayTrack {
  // Only extend if we're short by more than 500m.
  const remaining = routeTotalKm - track.totalKm;
  if (remaining < 0.5) return track;

  // Estimate pace from the last 5km (or last 20% of track, whichever is smaller).
  const lookbackKm = Math.min(5, track.totalKm * 0.2);
  const lookbackStart = track.totalKm - lookbackKm;
  let startIdx = 0;
  for (let i = track.distances.length - 1; i >= 0; i--) {
    if (track.distances[i] <= lookbackStart) {
      startIdx = i;
      break;
    }
  }
  const segKm = track.totalKm - track.distances[startIdx];
  const segTime = (track.timestamps[track.timestamps.length - 1] - track.timestamps[startIdx]) / 3600;
  const recentPace = segTime > 0 ? segKm / segTime : 3.5; // km/h
  const pace = Math.max(2.5, Math.min(8.0, recentPace));

  // Generate suffix points along the route from current end to finish.
  const suffixPath: Array<[number, number]> = [];
  const suffixTimestamps: number[] = [];
  const startSec = track.timestamps[track.timestamps.length - 1];
  const stepKm = 0.05;
  for (let km = track.totalKm + stepKm; km <= routeTotalKm; km += stepKm) {
    suffixPath.push(positionAtKmFn(km));
    const t = startSec + ((km - track.totalKm) / pace) * 3600;
    suffixTimestamps.push(t);
  }
  // Ensure the last point is at exactly routeTotalKm.
  if (suffixPath.length > 0) {
    const lastKm = track.totalKm + suffixPath.length * stepKm;
    if (lastKm < routeTotalKm - 0.01) {
      suffixPath.push(positionAtKmFn(routeTotalKm));
      suffixTimestamps.push(startSec + (remaining / pace) * 3600);
    }
  }

  const mergedPath = [...track.path, ...suffixPath];
  const mergedTimestamps = [...track.timestamps, ...suffixTimestamps];

  // Recalculate distances.
  const recalcDist: number[] = [0];
  let cum = 0;
  for (let i = 1; i < mergedPath.length; i++) {
    cum += haversineKm(mergedPath[i - 1], mergedPath[i]);
    recalcDist.push(cum);
  }

  return {
    ...track,
    path: mergedPath,
    timestamps: mergedTimestamps,
    distances: recalcDist,
    totalKm: cum,
    durationSec: mergedTimestamps[mergedTimestamps.length - 1],
  };
}

/**
 * Build the deck.gl data array for a set of replay tracks, applying the
 * chosen alignment mode.
 *
 * Side-by-side: all tracks start at simSec 0. Each track's timestamps are
 * used as-is (already relative to its own first point, now with prefix filling).
 *
 * Time-aligned: each track's timestamps are shifted by its real start time
 * minus the official event start (noon May 16). A track that started at 2pm
 * will have a 2-hour offset and appear at sim t=7200 s.
 */
export function buildReplayTrips(
  tracks: ReplayTrack[],
  mode: ReplayMode,
): ReplayTripData[] {
  if (tracks.length === 0) return [];

  if (mode === "side-by-side") {
    return tracks.map((t) => ({
      path: t.path,
      timestamps: t.timestamps,
      color: t.customColor ?? replayColor(t.colorIndex),
      track: t,
    }));
  }

  // Time-aligned: anchor to official event start, not earliest track.
  return tracks.map((t) => {
    const offsetSec = (t.startEpochMs - EVENT_START_EPOCH) / 1000;
    return {
      path: t.path,
      timestamps: t.timestamps.map((ts) => ts + offsetSec),
      color: t.customColor ?? replayColor(t.colorIndex),
      track: t,
    };
  });
}

/** Max sim-time across all trips (seconds). Used for loop-back. */
export function maxTripTime(trips: ReplayTripData[]): number {
  if (trips.length === 0) return 0;
  let max = 0;
  for (const t of trips) {
    const last = t.timestamps[t.timestamps.length - 1];
    if (last > max) max = last;
  }
  return max;
}

// ---- Queries ---------------------------------------------------------------

/** Distance covered by a track at a given sim second. */
export function kmAtSimSec(
  track: ReplayTrack,
  simSec: number,
  offsetSec: number,
): number {
  const t = simSec - offsetSec;
  if (t <= 0) return 0;
  if (t >= track.durationSec) return track.totalKm;

  // Linear scan for the segment containing t. Binary search not worth it
  // for typical GPX sizes (~1000-5000 points).
  for (let i = 1; i < track.timestamps.length; i++) {
    if (t <= track.timestamps[i]) {
      const frac =
        (t - track.timestamps[i - 1]) /
        (track.timestamps[i] - track.timestamps[i - 1]);
      return (
        track.distances[i - 1] +
        (track.distances[i] - track.distances[i - 1]) * frac
      );
    }
  }
  return track.totalKm;
}

/** Interpolated [lon, lat] position at a given sim second. */
export function positionAtSimSec(
  track: ReplayTrack,
  simSec: number,
  offsetSec: number,
): [number, number] {
  const t = simSec - offsetSec;
  if (t <= 0) return track.path[0];
  if (t >= track.durationSec) return track.path[track.path.length - 1];

  for (let i = 1; i < track.timestamps.length; i++) {
    if (t <= track.timestamps[i]) {
      const frac =
        (t - track.timestamps[i - 1]) /
        (track.timestamps[i] - track.timestamps[i - 1]);
      const p0 = track.path[i - 1];
      const p1 = track.path[i];
      return [
        p0[0] + (p1[0] - p0[0]) * frac,
        p0[1] + (p1[1] - p0[1]) * frac,
      ];
    }
  }
  return track.path[track.path.length - 1];
}

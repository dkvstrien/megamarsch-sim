// Route loading.
//
// V0 uses a synthetic Munich → Mittenwald polyline so the sim works before we
// have a real GPX. Real route goes in public/route.gpx; loadRouteGpx() will
// pick it up automatically when present.
//
// Coordinates below are real waypoints along the actual Megamarsch München
// route (Munich Harlaching → Pullach → Wolfratshausen → Walchensee → Mittenwald,
// roughly following the Isar then over toward the Karwendel). Densified later
// by linear interpolation; not survey-accurate but visually plausible until
// the real GPX is dropped in.

import { gpx as gpxToGeoJson } from "@tmcw/togeojson";

export interface RoutePoint {
  lon: number;
  lat: number;
  cumKm: number;
}

export interface RouteWaypoint {
  name: string;
  lon: number;
  lat: number;
  cumKm: number; // projected onto the route polyline
}

export interface Route {
  points: RoutePoint[];
  totalKm: number;
  waypoints: RouteWaypoint[];
}

/** Haversine distance in km between two lon/lat points. */
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

/** Build a Route from a sparse polyline by computing cumulative distance. */
function densify(
  coords: Array<[number, number]>,
  rawWaypoints: Array<{ name: string; lon: number; lat: number }> = [],
): Route {
  const points: RoutePoint[] = [];
  let cumKm = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) cumKm += haversineKm(coords[i - 1], coords[i]);
    points.push({ lon: coords[i][0], lat: coords[i][1], cumKm });
  }
  // Re-scale to exactly 100 km so the model and the polyline agree.
  const scale = 100 / cumKm;
  for (const p of points) p.cumKm *= scale;

  // Project each waypoint onto the route by finding the nearest polyline vertex.
  // Good enough for VPS markers; haversine to every point is cheap at 2.5k pts.
  const waypoints: RouteWaypoint[] = rawWaypoints.map((w) => {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = haversineKm([w.lon, w.lat], [points[i].lon, points[i].lat]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return {
      name: w.name,
      lon: w.lon,
      lat: w.lat,
      cumKm: points[bestIdx].cumKm,
    };
  });

  return { points, totalKm: 100, waypoints };
}

/** Synthetic Munich → Mittenwald route (placeholder until real GPX is added). */
export function syntheticRoute(): Route {
  // Hand-picked waypoints (lon, lat) approximating the real corridor.
  const waypoints: Array<[number, number]> = [
    [11.5419, 48.0974], // Munich Harlaching (start area)
    [11.5202, 48.0571], // Pullach
    [11.4869, 47.9985], // Schäftlarn
    [11.4262, 47.9105], // Wolfratshausen
    [11.4203, 47.8504], // Bichl area
    [11.3756, 47.7953], // Benediktbeuern
    [11.3357, 47.7128], // Kochel am See
    [11.3324, 47.6028], // Walchensee
    [11.2983, 47.5489], // Wallgau
    [11.2624, 47.4445], // Mittenwald (finish)
  ];

  // Linear interpolation: ~200 points so the polyline is smooth at zoom.
  const samples: Array<[number, number]> = [];
  const stepsPerSegment = 25;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [lon0, lat0] = waypoints[i];
    const [lon1, lat1] = waypoints[i + 1];
    for (let s = 0; s < stepsPerSegment; s++) {
      const t = s / stepsPerSegment;
      samples.push([lon0 + (lon1 - lon0) * t, lat0 + (lat1 - lat0) * t]);
    }
  }
  samples.push(waypoints[waypoints.length - 1]);
  return densify(samples, []);
}

/** Load /route.gpx if present; fall back to synthetic. */
export async function loadRoute(): Promise<Route> {
  try {
    const res = await fetch("/route.gpx");
    if (!res.ok) throw new Error("no gpx");
    const text = await res.text();
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const geo = gpxToGeoJson(xml);
    const line = geo.features.find(
      (f: { geometry: { type: string } }) =>
        f.geometry.type === "LineString" || f.geometry.type === "MultiLineString",
    );
    if (!line) throw new Error("no LineString in GPX");
    const geom = line.geometry as
      | { type: "LineString"; coordinates: Array<[number, number, number?]> }
      | { type: "MultiLineString"; coordinates: Array<Array<[number, number, number?]>> };
    const coords: Array<[number, number]> =
      geom.type === "LineString"
        ? geom.coordinates.map(([lon, lat]) => [lon, lat] as [number, number])
        : geom.coordinates.flat().map(([lon, lat]) => [lon, lat] as [number, number]);

    // Pull out waypoints (VPS markers) — Point features in the GeoJSON.
    const waypoints: Array<{ name: string; lon: number; lat: number }> = [];
    for (const f of geo.features) {
      if (f.geometry.type !== "Point") continue;
      const coord = (f.geometry as { coordinates: number[] }).coordinates;
      const name =
        ((f.properties as { name?: unknown } | null)?.name as string | undefined) ?? "VPS";
      waypoints.push({ name, lon: coord[0], lat: coord[1] });
    }

    return densify(coords, waypoints);
  } catch {
    return syntheticRoute();
  }
}

/** Linear-interpolate a position along the route at a given km. */
export function positionAtKm(route: Route, km: number): [number, number] {
  if (km <= 0) return [route.points[0].lon, route.points[0].lat];
  if (km >= route.totalKm) {
    const last = route.points[route.points.length - 1];
    return [last.lon, last.lat];
  }
  // Binary search would be tidier; linear scan is fine for ~200 points.
  for (let i = 1; i < route.points.length; i++) {
    const p0 = route.points[i - 1];
    const p1 = route.points[i];
    if (km <= p1.cumKm) {
      const t = (km - p0.cumKm) / (p1.cumKm - p0.cumKm);
      return [p0.lon + (p1.lon - p0.lon) * t, p0.lat + (p1.lat - p0.lat) * t];
    }
  }
  const last = route.points[route.points.length - 1];
  return [last.lon, last.lat];
}

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
  ele: number;   // elevation in meters (0 if unavailable)
  slope: number;  // gradient as fraction (positive = uphill)
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
  elevations: number[],
  rawWaypoints: Array<{ name: string; lon: number; lat: number }> = [],
): Route {
  const points: RoutePoint[] = [];
  let cumKm = 0;
  for (let i = 0; i < coords.length; i++) {
    if (i > 0) cumKm += haversineKm(coords[i - 1], coords[i]);
    const ele = elevations[i] ?? 0;
    points.push({ lon: coords[i][0], lat: coords[i][1], cumKm, ele, slope: 0 });
  }
  // Re-scale to exactly 100 km so the model and the polyline agree.
  const scale = 100 / cumKm;
  for (const p of points) p.cumKm *= scale;

  // Compute slope (gradient) between consecutive points.
  for (let i = 1; i < points.length; i++) {
    const dKm = haversineKm(
      [points[i - 1].lon, points[i - 1].lat],
      [points[i].lon, points[i].lat],
    );
    if (dKm > 0.001) {
      points[i].slope = (points[i].ele - points[i - 1].ele) / (dKm * 1000);
    }
  }

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
  return densify(samples, new Array(samples.length).fill(0), []);
}

/** Load /route.gpx if present; fall back to synthetic. */
export async function loadRoute(): Promise<Route> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}route.gpx`);
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

    // Extract elevation from trkpt <ele> tags.
    const trkptEls = xml.getElementsByTagName("trkpt");
    const elevations: number[] = [];
    for (let i = 0; i < trkptEls.length; i++) {
      const eleEl = trkptEls[i].getElementsByTagName("ele")[0];
      elevations.push(eleEl ? parseFloat(eleEl.textContent ?? "0") : 0);
    }
    // Pad elevations to match coords length.
    while (elevations.length < coords.length) elevations.push(elevations[elevations.length - 1] ?? 0);

    // Pull out waypoints (VPS markers) — Point features in the GeoJSON.
    const waypoints: Array<{ name: string; lon: number; lat: number }> = [];
    for (const f of geo.features) {
      if (f.geometry.type !== "Point") continue;
      const coord = (f.geometry as { coordinates: number[] }).coordinates;
      const name =
        ((f.properties as { name?: unknown } | null)?.name as string | undefined) ?? "VPS";
      waypoints.push({ name, lon: coord[0], lat: coord[1] });
    }

    return densify(coords, elevations, waypoints);
  } catch {
    return syntheticRoute();
  }
}

/** Binary-search + linear-interpolate a position along the route at a given km. */
export function positionAtKm(route: Route, km: number): [number, number] {
  if (km <= 0) return [route.points[0].lon, route.points[0].lat];
  if (km >= route.totalKm) {
    const last = route.points[route.points.length - 1];
    return [last.lon, last.lat];
  }
  // Binary search for the segment containing km.
  let lo = 0;
  let hi = route.points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (route.points[mid].cumKm < km) lo = mid + 1;
    else hi = mid;
  }
  const p0 = route.points[lo - 1];
  const p1 = route.points[lo];
  const t = (km - p0.cumKm) / (p1.cumKm - p0.cumKm);
  return [p0.lon + (p1.lon - p0.lon) * t, p0.lat + (p1.lat - p0.lat) * t];
}

// Entry point. Wires:
//   - MapLibre base map
//   - deck.gl Mapbox overlay with PathLayer (route) + TripsLayer (walkers)
//   - Top-left stats panel
//   - Bottom playhead (play/pause + speed slider + time display)

import maplibregl from "maplibre-gl";
import { Deck } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { Route } from "./route";
import { loadRoute } from "./route";
import {
  buildAllTrips,
  buildTrip,
  generateCohort,
  snapshotAt,
} from "./walkers";
import type { Trip, Walker } from "./walkers";
import { BANDS, CUTOFF_HOURS, ROUTE_KM, bandById, flatFinishTime } from "./model";

const COHORT_SIZE = 150;
const START_WINDOW_MIN = 120;
const SEED = 42;
const STORAGE_KEY = "megamarsch-sim:my-walker:v1";

interface SavedWalker {
  name: string;
  bandId: number;
}

// ---- Bootstrap ---------------------------------------------------------------

async function main() {
  const route = await loadRoute();

  // Filler-only cohort. The user's walker is added on top via the sign-up flow.
  const cohort = generateCohort({
    size: COHORT_SIZE,
    realWalkers: [],
    startWindowMin: START_WINDOW_MIN,
    seed: SEED,
  });

  const trips = buildAllTrips(cohort, route);
  let myWalker: Walker | null = null;
  let myTrip: Trip | null = null;

  // Camera target: route midpoint.
  const mid = route.points[Math.floor(route.points.length / 2)];

  const map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    center: [mid.lon, mid.lat],
    zoom: 9,
    attributionControl: { compact: true },
  });

  await new Promise<void>((resolve) => map.on("load", () => resolve()));

  // deck.gl overlay rendered into a transparent canvas above the map.
  const deck = new Deck({
    canvas: createDeckCanvas(map),
    initialViewState: {
      longitude: mid.lon,
      latitude: mid.lat,
      zoom: 9,
      pitch: 0,
      bearing: 0,
    },
    controller: false,
  });

  // Sync MapLibre <-> deck.gl camera.
  syncCameras(map, deck);

  // Time loop ----------------------------------------------------------------

  const state = {
    simSec: 0, // seconds since cohort start
    speed: 60, // multiplier (1 = real time, 60 = 1 wall-second is 1 sim minute)
    paused: false,
    lastFrameMs: performance.now(),
  };

  // Hook up controls.
  const playBtn = byId<HTMLButtonElement>("play-pause");
  const speedSlider = byId<HTMLInputElement>("speed");
  const speedDisplay = byId<HTMLSpanElement>("speed-display");
  const timeDisplay = byId<HTMLSpanElement>("time-display");

  playBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    playBtn.textContent = state.paused ? "Play" : "Pause";
    playBtn.classList.toggle("paused", state.paused);
  });
  speedSlider.addEventListener("input", () => {
    state.speed = parseInt(speedSlider.value, 10);
    speedDisplay.textContent = `${state.speed}×`;
  });

  // Stats panel
  const statWalkers = byId<HTMLElement>("stat-walkers");
  const statActive = byId<HTMLElement>("stat-active");
  const statFinished = byId<HTMLElement>("stat-finished");
  const statDnf = byId<HTMLElement>("stat-dnf");
  const statTime = byId<HTMLElement>("stat-time");
  const myCard = byId<HTMLElement>("my-walker-card");
  const myName = byId<HTMLElement>("my-walker-name");
  const myStatus = byId<HTMLElement>("my-walker-status");
  const myKm = byId<HTMLElement>("my-walker-km");
  const myBand = byId<HTMLElement>("my-walker-band");
  const myRank = byId<HTMLElement>("my-walker-rank");
  const myEta = byId<HTMLElement>("my-walker-eta");
  const mySvg = byId<SVGSVGElement>("my-walker-svg");
  const refreshWalkerCount = () => {
    statWalkers.textContent = String(cohort.length + (myWalker ? 1 : 0));
  };
  refreshWalkerCount();

  // ---- Sign-up flow --------------------------------------------------------

  setupSignup({
    route,
    onSubmit: (name, bandId) => {
      const walker = createUserWalker(name, bandId, state.simSec);
      myWalker = walker;
      myTrip = buildTrip(walker, route);
      saveSavedWalker({ name, bandId });
      refreshWalkerCount();
      myCard.hidden = false;
    },
  });

  byId<HTMLButtonElement>("change-walker").addEventListener("click", () => {
    showSignup(myWalker ? { name: myWalker.name, bandId: myWalker.bandId } : null);
  });

  const saved = loadSavedWalker();
  if (saved) {
    const walker = createUserWalker(saved.name, saved.bandId, 0);
    myWalker = walker;
    myTrip = buildTrip(walker, route);
    refreshWalkerCount();
    myCard.hidden = false;
  } else {
    showSignup(null);
  }

  function tick() {
    const now = performance.now();
    const dtMs = now - state.lastFrameMs;
    state.lastFrameMs = now;

    if (!state.paused) {
      state.simSec += (dtMs / 1000) * state.speed;
      // Loop back at 26 hours so the sim restarts visually.
      if (state.simSec > (CUTOFF_HOURS + 2) * 3600) state.simSec = 0;
    }

    const allTrips = myTrip ? [...trips, myTrip] : trips;
    deck.setProps({
      layers: makeLayers(route, allTrips, state.simSec),
    });

    // Stats counts via snapshot (cheap; 150 walkers).
    let active = 0;
    let finished = 0;
    let dnf = 0;
    const tHours = state.simSec / 3600;
    for (const w of cohort) {
      const s = snapshotAt(w, route, tHours);
      if (s.status === "walking") active++;
      else if (s.status === "finished") finished++;
      else if (s.status === "dnf") dnf++;
    }
    if (myWalker) {
      const s = snapshotAt(myWalker, route, tHours);
      if (s.status === "walking") active++;
      else if (s.status === "finished") finished++;
      else if (s.status === "dnf") dnf++;

      myName.textContent = myWalker.name;
      const statusKey = s.status === "pre-start" ? "walking" : s.status;
      myStatus.textContent = statusLabel(s.status);
      myStatus.className = `mw-status ${statusKey}`;
      const band = bandById(myWalker.bandId);
      myBand.textContent = `Band ${band.id} • ${band.label}`;
      myKm.textContent = `${s.km.toFixed(1)} km`;

      // Rank: how many walkers (cohort + me) have farther km AND haven't DNF'd.
      let ahead = 0;
      let total = 0;
      for (const w of cohort) {
        const ws = snapshotAt(w, route, tHours);
        if (ws.status === "dnf") continue;
        total++;
        if (ws.km > s.km) ahead++;
      }
      total++; // me
      myRank.textContent = `${ahead + 1} / ${total}`;

      // Projected finish from current pace_0: total flat-100km time minus
      // time-elapsed-since-they-started.
      if (s.status === "finished") {
        const finishHours = state.simSec / 3600 - myWalker.startOffsetMin / 60;
        myEta.textContent = formatHM(finishHours * 3600);
      } else if (s.status === "dnf") {
        myEta.textContent = "—";
      } else {
        const totalH = flatFinishTime(myWalker.pace0);
        const finishHours = totalH; // wall-clock from their start
        myEta.textContent = formatHM(finishHours * 3600);
      }

      // Histogram: bins of 1 km width, count walkers in each bin who are
      // currently walking (not DNF'd, not pre-start).
      updateHistogram(mySvg, route, cohort, myWalker, s.km, tHours);
    }
    statActive.textContent = String(active);
    statFinished.textContent = String(finished);
    statDnf.textContent = String(dnf);
    statTime.textContent = formatHM(state.simSec);
    timeDisplay.textContent = formatHM(state.simSec);

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---- Histogram of walkers along the route ----------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function updateHistogram(
  svg: SVGSVGElement,
  route: Route,
  cohort: Walker[],
  me: Walker,
  myKm: number,
  tHours: number,
) {
  // Bin walkers (cohort + me) into 1-km buckets.
  const bins = new Array<number>(ROUTE_KM).fill(0);
  let maxBin = 0;
  const tally = (w: Walker) => {
    const s = snapshotAt(w, route, tHours);
    if (s.status === "pre-start" || s.status === "dnf") return;
    const idx = Math.min(ROUTE_KM - 1, Math.floor(s.km));
    bins[idx]++;
    if (bins[idx] > maxBin) maxBin = bins[idx];
  };
  for (const w of cohort) tally(w);
  tally(me);

  // Re-render. We reuse svg children as best as possible to avoid GC churn.
  // For 100 bins + ~5 VPS markers + 1 user marker this is cheap to fully rewrite.
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Background route line.
  const baseLine = document.createElementNS(SVG_NS, "rect");
  baseLine.setAttribute("x", "0");
  baseLine.setAttribute("y", "26");
  baseLine.setAttribute("width", "100");
  baseLine.setAttribute("height", "1");
  baseLine.setAttribute("fill", "#30363d");
  svg.appendChild(baseLine);

  // Histogram bars.
  if (maxBin > 0) {
    for (let i = 0; i < ROUTE_KM; i++) {
      if (bins[i] === 0) continue;
      const h = (bins[i] / maxBin) * 22;
      const bar = document.createElementNS(SVG_NS, "rect");
      bar.setAttribute("x", String(i));
      bar.setAttribute("y", String(26 - h));
      bar.setAttribute("width", "0.85");
      bar.setAttribute("height", String(h));
      bar.setAttribute("fill", "#6e7681");
      svg.appendChild(bar);
    }
  }

  // VPS tick marks below the line.
  for (const wp of route.waypoints) {
    const tick = document.createElementNS(SVG_NS, "line");
    tick.setAttribute("x1", String(wp.cumKm));
    tick.setAttribute("y1", "26");
    tick.setAttribute("x2", String(wp.cumKm));
    tick.setAttribute("y2", "31");
    tick.setAttribute("stroke", "#58a6ff");
    tick.setAttribute("stroke-width", "0.6");
    svg.appendChild(tick);
  }

  // Finish marker.
  const finish = document.createElementNS(SVG_NS, "line");
  finish.setAttribute("x1", "100");
  finish.setAttribute("y1", "20");
  finish.setAttribute("x2", "100");
  finish.setAttribute("y2", "31");
  finish.setAttribute("stroke", "#56d364");
  finish.setAttribute("stroke-width", "0.7");
  svg.appendChild(finish);

  // User marker.
  const userBar = document.createElementNS(SVG_NS, "line");
  userBar.setAttribute("x1", String(myKm));
  userBar.setAttribute("y1", "0");
  userBar.setAttribute("x2", String(myKm));
  userBar.setAttribute("y2", "26");
  userBar.setAttribute("stroke", "#58a6ff");
  userBar.setAttribute("stroke-width", "0.6");
  svg.appendChild(userBar);

  const userDot = document.createElementNS(SVG_NS, "circle");
  userDot.setAttribute("cx", String(myKm));
  userDot.setAttribute("cy", "26");
  userDot.setAttribute("r", "1.6");
  userDot.setAttribute("fill", "#58a6ff");
  userDot.setAttribute("stroke", "#0d1117");
  userDot.setAttribute("stroke-width", "0.4");
  svg.appendChild(userDot);
}

function statusLabel(s: "pre-start" | "walking" | "finished" | "dnf"): string {
  switch (s) {
    case "pre-start": return "warming up";
    case "walking": return "walking";
    case "finished": return "FINISHED ✓";
    case "dnf": return "DNF";
  }
}

// ---- User walker creation + persistence -------------------------------------

function createUserWalker(name: string, bandId: number, currentSimSec: number): Walker {
  const band = bandById(bandId);
  return {
    id: `me-${Date.now()}`,
    name,
    bandId,
    pace0: band.pace0,
    startOffsetMin: currentSimSec / 60,
    dnfKm: null, // user walker always finishes in v0 — friend-pleasing default
    isReal: true,
  };
}

function loadSavedWalker(): SavedWalker | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.name === "string" && typeof parsed?.bandId === "number") {
      return { name: parsed.name, bandId: parsed.bandId };
    }
  } catch {
    // fall through
  }
  return null;
}

function saveSavedWalker(w: SavedWalker) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
  } catch {
    // localStorage may fail in private mode; we don't block on it
  }
}

// ---- Sign-up modal ----------------------------------------------------------

interface SignupContext {
  route: Route;
  onSubmit: (name: string, bandId: number) => void;
}

let signupCtx: SignupContext | null = null;
let signupSelectedBand: number | null = null;

function setupSignup(ctx: SignupContext) {
  signupCtx = ctx;

  const optionsEl = byId<HTMLElement>("band-options");
  optionsEl.innerHTML = "";
  for (const b of BANDS) {
    const finishH = flatFinishTime(b.pace0);
    const fh = Math.floor(finishH);
    const fm = Math.round((finishH - fh) * 60);
    const finishStr = `~${fh}h ${String(fm).padStart(2, "0")}m`;
    const row = document.createElement("label");
    row.className = "band-row";
    row.dataset.bandId = String(b.id);
    row.innerHTML = `
      <input type="radio" name="band" value="${b.id}" />
      <span class="band-color-dot" style="background: rgb(${BAND_COLORS[b.id].join(",")})"></span>
      <span class="band-info">
        <span class="band-name">${b.id}. ${b.label}</span>
        <span class="band-blurb">${b.blurb}</span>
      </span>
      <span class="band-finish">${finishStr}</span>
    `;
    row.addEventListener("click", () => selectBand(b.id));
    optionsEl.appendChild(row);
  }

  const nameInput = byId<HTMLInputElement>("signup-name");
  const submitBtn = byId<HTMLButtonElement>("signup-submit");

  const refreshSubmit = () => {
    const ok = nameInput.value.trim().length > 0 && signupSelectedBand !== null;
    submitBtn.disabled = !ok;
  };
  nameInput.addEventListener("input", refreshSubmit);

  submitBtn.addEventListener("click", () => {
    const name = nameInput.value.trim();
    if (!name || signupSelectedBand === null) return;
    if (signupCtx) signupCtx.onSubmit(name, signupSelectedBand);
    hideSignup();
  });
}

function selectBand(id: number) {
  signupSelectedBand = id;
  document.querySelectorAll<HTMLElement>(".band-row").forEach((r) => {
    const isActive = r.dataset.bandId === String(id);
    r.classList.toggle("active", isActive);
    const input = r.querySelector<HTMLInputElement>('input[type=radio]');
    if (input) input.checked = isActive;
  });
  byId<HTMLButtonElement>("signup-submit").disabled =
    byId<HTMLInputElement>("signup-name").value.trim().length === 0;
}

function showSignup(prefill: SavedWalker | null) {
  byId<HTMLElement>("signup-overlay").hidden = false;
  const nameInput = byId<HTMLInputElement>("signup-name");
  if (prefill) {
    nameInput.value = prefill.name;
    selectBand(prefill.bandId);
  } else {
    nameInput.value = "";
    signupSelectedBand = null;
    document.querySelectorAll<HTMLElement>(".band-row").forEach((r) => {
      r.classList.remove("active");
      const input = r.querySelector<HTMLInputElement>('input[type=radio]');
      if (input) input.checked = false;
    });
    byId<HTMLButtonElement>("signup-submit").disabled = true;
  }
  setTimeout(() => nameInput.focus(), 50);
  byId<HTMLElement>("signup-error").textContent = "";
}

function hideSignup() {
  byId<HTMLElement>("signup-overlay").hidden = true;
}

// ---- Layer construction ------------------------------------------------------

const BAND_COLORS: Record<number, [number, number, number]> = {
  1: [188, 140, 90], // earth
  2: [102, 153, 204], // muted blue
  3: [124, 196, 121], // green
  4: [232, 165, 81], // orange
  5: [220, 86, 86], // red
};

function makeLayers(route: Route, trips: Trip[], currentSec: number) {
  const routePath = route.points.map<[number, number]>((p) => [p.lon, p.lat]);

  const trail = new TripsLayer<Trip>({
    id: "walkers-trail",
    data: trips,
    getPath: (d) => d.path,
    getTimestamps: (d) => d.timestamps,
    getColor: (d) => BAND_COLORS[d.walker.bandId],
    opacity: 0.6,
    widthMinPixels: 2,
    jointRounded: true,
    capRounded: true,
    trailLength: 1800, // 30 minutes of trail behind each walker
    currentTime: currentSec,
  });

  // Dot layer for the head of each walker.
  const heads = new ScatterplotLayer({
    id: "walker-heads",
    data: trips,
    getPosition: (d: Trip) => {
      // Interpolate position at currentSec.
      const ts = d.timestamps;
      if (currentSec <= ts[0]) return [d.path[0][0], d.path[0][1], 0];
      if (currentSec >= ts[ts.length - 1])
        return [d.path[ts.length - 1][0], d.path[ts.length - 1][1], 0];
      // Linear scan; could binary-search but cohort is small.
      for (let i = 1; i < ts.length; i++) {
        if (currentSec <= ts[i]) {
          const t = (currentSec - ts[i - 1]) / (ts[i] - ts[i - 1]);
          const p0 = d.path[i - 1];
          const p1 = d.path[i];
          return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, 0];
        }
      }
      return [d.path[0][0], d.path[0][1], 0];
    },
    getRadius: (d: Trip) => (d.walker.isReal ? 600 : 300),
    radiusUnits: "meters",
    radiusMinPixels: 3,
    radiusMaxPixels: 14,
    getFillColor: (d: Trip) => {
      const ts = d.timestamps;
      // Faded if pre-start or post-finish.
      if (currentSec < ts[0]) return [120, 120, 120, 80];
      if (currentSec >= ts[ts.length - 1]) {
        return d.finishStatus === "dnf" ? [80, 80, 80, 140] : [255, 255, 255, 200];
      }
      const c = BAND_COLORS[d.walker.bandId];
      return [c[0], c[1], c[2], d.walker.isReal ? 255 : 200];
    },
    stroked: true,
    getLineColor: (d: Trip) => (d.walker.isReal ? [255, 255, 255, 255] : [0, 0, 0, 0]),
    lineWidthMinPixels: 1,
  });

  const baseRoute = new PathLayer({
    id: "route",
    data: [{ path: routePath }],
    getPath: (d: { path: Array<[number, number]> }) => d.path,
    getColor: [255, 255, 255, 140],
    getWidth: 3,
    widthMinPixels: 2,
  });

  return [baseRoute, trail, heads];
}

// ---- Camera + canvas helpers -------------------------------------------------

function createDeckCanvas(map: maplibregl.Map): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.style.position = "absolute";
  c.style.inset = "0";
  c.style.pointerEvents = "none";
  map.getContainer().appendChild(c);
  const resize = () => {
    const r = map.getContainer().getBoundingClientRect();
    c.width = r.width * window.devicePixelRatio;
    c.height = r.height * window.devicePixelRatio;
    c.style.width = `${r.width}px`;
    c.style.height = `${r.height}px`;
  };
  resize();
  window.addEventListener("resize", resize);
  return c;
}

function syncCameras(map: maplibregl.Map, deck: Deck) {
  const update = () => {
    const c = map.getCenter();
    deck.setProps({
      viewState: {
        longitude: c.lng,
        latitude: c.lat,
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      },
    });
  };
  map.on("move", update);
  map.on("zoom", update);
  map.on("rotate", update);
  map.on("pitch", update);
  update();
}

// ---- Utilities ---------------------------------------------------------------

function byId<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as unknown as T;
}

function formatHM(sec: number): string {
  const totalMin = Math.floor(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Suppress unused-warning for BANDS — exported for legend rendering later.
void BANDS;

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f88;padding:24px">${e.stack ?? e}</pre>`;
});

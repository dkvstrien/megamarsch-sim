// Entry point. Wires:
//   - MapLibre base map
//   - deck.gl Mapbox overlay with PathLayer (route) + TripsLayer (walkers)
//   - Top-left stats panel (with replay track sidebar)
//   - Bottom playhead (play/pause + speed slider + time display)

import maplibregl from "maplibre-gl";
import { Deck } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { TripsLayer } from "@deck.gl/geo-layers";
import type { Route } from "./route";
import { loadRoute, positionAtKm } from "./route";
import { buildTrip, generateCohort, snapshotAt } from "./walkers";
import type { Trip, Walker } from "./walkers";
import {
  BANDS,
  CUTOFF_HOURS,
  ROUTE_KM,
  SCHLUSSLAEUFER_PACE0,
  VORLAEUFER_PACE0,
  bandById,
  flatFinishTime,
} from "./model";
import {
  parseGpxFile,
  fillMissingRoutePrefix,
  buildReplayTrips,
  maxTripTime,
  kmAtSimSec,
  replayColor,
} from "./replay";
import type { ReplayTrack, ReplayMode, ReplayTripData } from "./replay";
import { EVENT_START_EPOCH } from "./replay";

const STORAGE_KEY = "megamarsch-sim:my-walkers:v2";

interface SavedWalker {
  id: string;
  name: string;
  bandId: number;
}

// ---- Bootstrap ---------------------------------------------------------------

async function main() {
  const route = await loadRoute();

  // Filler cohort — disabled for now (real data replay is the focus).
  // Restore with:
  //   const cohort = generateCohort({ size: 150, realWalkers: [], startWindowMin: 120, seed: 42 });
  //   const trips = buildAllTrips(cohort, route);

  const userWalkers: Walker[] = [];
  const userTrips: Trip[] = [];

  // Per-user-walker color assignment (used by layers and by renderUserWalkers).
  const userWalkerColorIdx = new Map<string, number>();
  let nextUwColor = 0;

  // ---- Replay state --------------------------------------------------------

  const replayTracks = new Map<string, ReplayTrack>();
  let replayMode: ReplayMode = "side-by-side";
  let nextColorIndex = 0;

  // ---- Schlussläufer & Vorläufer -------------------------------------------
  // Official pace-makers from the handbook. Always present.
  const schlusslaeufer: Walker = {
    id: "schlusslaeufer",
    name: "Schlussläufer",
    bandId: -1,
    pace0: SCHLUSSLAEUFER_PACE0,
    startOffsetMin: 120,
    dnfKm: null,
    isReal: true,
  };
  const vorlaeufer: Walker = {
    id: "vorlaeufer",
    name: "Vorläufer",
    bandId: -2,
    pace0: VORLAEUFER_PACE0,
    startOffsetMin: 0,
    dnfKm: null,
    isReal: true,
  };
  const schlussTrip = buildTrip(schlusslaeufer, route);
  const vorTrip = buildTrip(vorlaeufer, route);

  // ---- Filler cohort (togglable) ------------------------------------------
  let cohort: Walker[] = [];
  const cohortToggle = byId<HTMLInputElement>("cohort-toggle");
  const cohortInfo = byId<HTMLElement>("cohort-info");
  const cohortCount = byId<HTMLSelectElement>("cohort-count");
  const histSvg = byId<SVGSVGElement>("histogram-svg");

  // VPS3 km position for bus effect (find the indoor checkpoint).
  const vps3Km =
    route.waypoints.length >= 3
      ? [...route.waypoints].sort((a, b) => a.cumKm - b.cumKm)[2]?.cumKm ?? 70
      : 70;

  // Track walkers currently riding the VPS3 bus.
  const busRiders = new Map<string, number>(); // walker id → simSec when they board

  function enableCohort() {
    const size = parseInt(cohortCount.value, 10) || 200;
    const checkpointKm = route.waypoints.map((wp) => wp.cumKm);
    cohort = generateCohort({
      size,
      realWalkers: [],
      startWindowMin: 120,
      waveCount: 8,
      seed: 42,
      checkpointKm,
    });
    busRiders.clear();
    updateCohortInfo();
  }

  function disableCohort() {
    cohort = [];
    busRiders.clear();
    updateCohortInfo();
  }

  function updateCohortInfo() {
    if (cohort.length === 0) {
      cohortInfo.textContent = "off";
    } else {
      const bandCounts = new Map<string, number>();
      for (const w of cohort) {
        const b = bandById(w.bandId);
        bandCounts.set(b.label, (bandCounts.get(b.label) ?? 0) + 1);
      }
      const parts: string[] = [];
      for (const [label, count] of bandCounts) {
        parts.push(`${label}: ${count}`);
      }
      cohortInfo.textContent = `${cohort.length} walkers · ${parts.join(" · ")}`;
    }
  }

  cohortToggle.addEventListener("change", () => {
    if (cohortToggle.checked) enableCohort();
    else disableCohort();
  });
  cohortCount.addEventListener("change", () => {
    if (cohortToggle.checked) enableCohort();
  });

  // Default: cohort ON, 200 walkers.
  cohortToggle.checked = true;
  cohortCount.value = "200";
  enableCohort();

  // ---- Camera target: route midpoint ----------------------------------------

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
  const restartBtn = byId<HTMLButtonElement>("restart-btn");
  const speedSlider = byId<HTMLInputElement>("speed");
  const speedDisplay = byId<HTMLSpanElement>("speed-display");
  const timeDisplay = byId<HTMLSpanElement>("time-display");
  const timeline = byId<HTMLInputElement>("timeline");
  const scrubLabel = byId<HTMLSpanElement>("scrub-label");
  const scrubTotal = byId<HTMLSpanElement>("scrub-total");

  let isScrubbing = false;

  playBtn.addEventListener("click", () => {
    state.paused = !state.paused;
    playBtn.textContent = state.paused ? "Play" : "Pause";
    playBtn.classList.toggle("paused", state.paused);
  });
  restartBtn.addEventListener("click", () => {
    state.simSec = 0;
  });
  speedSlider.addEventListener("input", () => {
    state.speed = parseInt(speedSlider.value, 10);
    speedDisplay.textContent = `${state.speed}×`;
  });

  // Scrubber: seek to any point in the timeline.
  timeline.addEventListener("input", () => {
    isScrubbing = true;
    state.simSec = parseInt(timeline.value, 10);
    scrubLabel.textContent = formatHM(state.simSec);
  });
  timeline.addEventListener("change", () => {
    // Mouse released — stop overriding from tick.
    isScrubbing = false;
  });
  // Pointer/touch end to catch drag release outside the element.
  timeline.addEventListener("pointerup", () => { isScrubbing = false; });
  timeline.addEventListener("touchend", () => { isScrubbing = false; });

  // Stats panel
  const statWalkers = byId<HTMLElement>("stat-walkers");
  const statActive = byId<HTMLElement>("stat-active");
  const statFinished = byId<HTMLElement>("stat-finished");
  const statDnf = byId<HTMLElement>("stat-dnf");
  const statTime = byId<HTMLElement>("stat-time");
  const statClock = byId<HTMLElement>("stat-clock");
  const userWalkerList = byId<HTMLElement>("user-walker-list");

  // Replay UI elements
  const replayInput = byId<HTMLInputElement>("replay-file-input");
  const replayList = byId<HTMLElement>("replay-list");
  const replayEmpty = byId<HTMLElement>("replay-empty");
  const modeSideBySide = byId<HTMLInputElement>("replay-mode-sbs");
  const modeTimeAligned = byId<HTMLInputElement>("replay-mode-aligned");
  const replayUploadBtn = byId<HTMLButtonElement>("replay-upload-btn");

  replayUploadBtn.addEventListener("click", () => replayInput.click());

  // ---- File upload ---------------------------------------------------------

  replayInput.addEventListener("change", async () => {
    const files = replayInput.files;
    if (!files || files.length === 0) return;

    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // Accept .gpx, .gpx.txt (Strava), .xml — let the parser decide.
      const lc2 = file.name.toLowerCase();
      if (!lc2.endsWith(".gpx") && !lc2.endsWith(".gpx.txt") && !lc2.endsWith(".xml")) {
        if (lc2.endsWith(".png") || lc2.endsWith(".jpg") || lc2.endsWith(".jpeg") ||
            lc2.endsWith(".pdf") || lc2.endsWith(".zip")) continue;
      }

      try {
        let track = await parseGpxFile(file, nextColorIndex);
        // Fill missing route prefix (late recording start, etc.).
        track = fillMissingRoutePrefix(
          track,
          route.points,
          (km) => positionAtKm(route, km),
        );
        replayTracks.set(track.id, track);
        nextColorIndex++;
        added++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorDiv = byId<HTMLElement>("replay-error");
        errorDiv.textContent = `${file.name}: ${msg}`;
        errorDiv.hidden = false;
        setTimeout(() => {
          errorDiv.hidden = true;
          errorDiv.textContent = "";
        }, 5000);
      }
    }

    // Reset file input so the same file can be re-selected.
    replayInput.value = "";

    if (added > 0) {
      renderTrackList();
    }
  });

  modeSideBySide.addEventListener("change", () => {
    if (modeSideBySide.checked) replayMode = "side-by-side";
  });
  modeTimeAligned.addEventListener("change", () => {
    if (modeTimeAligned.checked) replayMode = "time-aligned";
  });

  // ---- Replay track list rendering -----------------------------------------

  function renderTrackList() {
    replayList.innerHTML = "";
    // Sort by current progress (km) descending — leader first.
    const entries = Array.from(replayTracks.values()).sort((a, b) => {
      let oa = 0, ob = 0;
      if (replayMode === "time-aligned") {
        oa = (a.startEpochMs - EVENT_START_EPOCH) / 1000;
        ob = (b.startEpochMs - EVENT_START_EPOCH) / 1000;
      }
      const ka = kmAtSimSec(a, state.simSec, oa);
      const kb = kmAtSimSec(b, state.simSec, ob);
      return kb - ka;
    });
    replayEmpty.hidden = entries.length > 0;

    if (entries.length === 0) {
      replayInput.value = "";
      return;
    }

    for (const track of entries) {
      const color = track.customColor ?? replayColor(track.colorIndex);
      const colorStr = `rgb(${color[0]},${color[1]},${color[2]})`;

      const row = document.createElement("div");
      row.className = "replay-row";
      row.dataset.trackId = track.id;

      row.innerHTML = `
        <span class="replay-swatch" style="background:${colorStr}" data-swatch="${track.id}" title="Click to cycle color"></span>
        <span class="replay-name" data-name="${track.id}" title="Click to rename">${escapeHtml(track.name)}</span>
        <span class="replay-km" data-track-km="${track.id}">0.0 km</span>
        <span class="replay-bar-wrap">
          <span class="replay-bar" style="width:0%;background:${colorStr};" data-track-bar="${track.id}"></span>
        </span>
        <button class="replay-remove" data-remove="${track.id}" title="Remove track">×</button>
      `;

      replayList.appendChild(row);
    }

    // Wire up color swatch clicks — cycle through palette.
    replayList.querySelectorAll<HTMLElement>(".replay-swatch").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.swatch;
        if (!id) return;
        const track = replayTracks.get(id);
        if (!track) return;
        // Cycle colorIndex and clear customColor (auto palette mode).
        track.colorIndex++;
        track.customColor = null;
        renderTrackList();
      });
    });

    // Wire up name clicks — inline rename.
    replayList.querySelectorAll<HTMLElement>(".replay-name").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.name;
        if (!id) return;
        const track = replayTracks.get(id);
        if (!track) return;
        const oldName = track.name;
        // Replace with an input field.
        const input = document.createElement("input");
        input.type = "text";
        input.value = oldName;
        input.className = "replay-name-edit";
        input.maxLength = 40;
        const commit = () => {
          const newName = input.value.trim();
          if (newName && newName !== oldName) {
            track.name = newName;
          }
          renderTrackList();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            input.value = oldName;
            commit();
          }
        });
        el.replaceWith(input);
        input.focus();
        input.select();
      });
    });

    // Wire up remove buttons.
    replayList.querySelectorAll<HTMLButtonElement>(".replay-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.remove;
        if (id) {
          replayTracks.delete(id);
          renderTrackList();
        }
      });
    });
  }

  // ---- User walker management (add / edit / remove) -----------------------

  // Load saved walkers from localStorage.
  const savedWalkers = loadSavedWalkers();
  for (const sw of savedWalkers) {
    const w = createUserWalker(sw.id, sw.name, sw.bandId, 0);
    userWalkers.push(w);
    userTrips.push(buildTrip(w, route));
    userWalkerColorIdx.set(sw.id, nextUwColor);
    nextUwColor++;
  }

  let editingWalkerId: string | null = null;

  function renderUserWalkers() {
    userWalkerList.innerHTML = "";

    if (userWalkers.length === 0) {
      userWalkerList.innerHTML =
        '<div class="uw-empty">No walkers yet. Click + to add one.</div>';
      return;
    }

    for (const w of userWalkers) {
      const band = bandById(w.bandId);
      const ci = userWalkerColorIdx.get(w.id);
      const c = ci !== undefined
        ? USER_WALKER_COLORS[ci % USER_WALKER_COLORS.length]
        : BAND_COLORS[w.bandId] ?? [150, 150, 150];
      const colorDot = `rgb(${c[0]},${c[1]},${c[2]})`;

      const row = document.createElement("div");
      row.className = "uw-row";
      row.dataset.walkerId = w.id;
      row.innerHTML = `
        <span class="uw-dot" style="background:${colorDot}"></span>
        <span class="uw-name">${escapeHtml(w.name)}</span>
        <span class="uw-band">${band.label}</span>
        <span class="uw-km" id="uw-km-${w.id}">0 km</span>
        <span class="uw-status" id="uw-status-${w.id}">—</span>
        <button class="uw-edit" data-edit="${w.id}" title="Edit">✎</button>
        <button class="uw-remove" data-remove="${w.id}" title="Remove">×</button>
      `;
      userWalkerList.appendChild(row);
    }

    // Wire up edit buttons.
    userWalkerList.querySelectorAll<HTMLButtonElement>(".uw-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.edit;
        if (!id) return;
        const w = userWalkers.find((u) => u.id === id);
        if (w) {
          editingWalkerId = id;
          showSignup({ id: w.id, name: w.name, bandId: w.bandId });
        }
      });
    });

    // Wire up remove buttons.
    userWalkerList.querySelectorAll<HTMLButtonElement>(".uw-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.remove;
        if (!id) return;
        const idx = userWalkers.findIndex((u) => u.id === id);
        if (idx !== -1) {
          userWalkers.splice(idx, 1);
          userTrips.splice(idx, 1);
          persistUserWalkers();
          renderUserWalkers();
        }
      });
    });
  }

  setupSignup({
    route,
    onSubmit: (name, bandId) => {
      if (editingWalkerId) {
        // Edit existing walker.
        const idx = userWalkers.findIndex((w) => w.id === editingWalkerId);
        if (idx !== -1) {
          const band = bandById(bandId);
          userWalkers[idx] = {
            ...userWalkers[idx],
            name,
            bandId,
            pace0: band.pace0,
          };
          userTrips[idx] = buildTrip(userWalkers[idx], route);
        }
        editingWalkerId = null;
      } else {
        // Add new walker.
        const id = `uw-${Date.now()}`;
        const w = createUserWalker(id, name, bandId, state.simSec);
        userWalkers.push(w);
        userTrips.push(buildTrip(w, route));
        userWalkerColorIdx.set(id, nextUwColor);
        nextUwColor++;
      }
      persistUserWalkers();
      renderUserWalkers();
    },
  });

  byId<HTMLButtonElement>("add-walker-btn").addEventListener("click", () => {
    editingWalkerId = null;
    showSignup(null);
  });

  function persistUserWalkers() {
    const data: SavedWalker[] = userWalkers.map((w) => ({
      id: w.id,
      name: w.name,
      bandId: w.bandId,
    }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // ignore
    }
  }

  renderUserWalkers();

  // ---- Main tick loop ------------------------------------------------------

  function tick() {
    const now = performance.now();
    const dtMs = now - state.lastFrameMs;
    state.lastFrameMs = now;

    if (!state.paused) {
      state.simSec += (dtMs / 1000) * state.speed;

      // Loop back when all tracks are done.
      const replayTrips = buildReplayTrips(
        Array.from(replayTracks.values()),
        replayMode,
      );
      const maxTime = Math.max(
        maxTripTime(replayTrips) + 3600,
        (CUTOFF_HOURS + 2) * 3600,
      );
      if (state.simSec > maxTime) state.simSec = 0;
    }

    // ---- Replay data for this frame ----------------------------------------
    const allTracks = Array.from(replayTracks.values());
    const replayTrips = buildReplayTrips(allTracks, replayMode);

    // ---- Replay head positions (computed here, used in ScatterplotLayer) ---
    const replayHeads: ReplayHead[] = [];
    for (const rt of replayTrips) {
      const track = rt.track;
      let offsetSec = 0;
      if (replayMode === "time-aligned") {
        offsetSec = (track.startEpochMs - EVENT_START_EPOCH) / 1000;
      }

      const t = state.simSec - offsetSec;
      const active = t >= 0 && t <= track.durationSec;

      let headPos: [number, number] = track.path[0];
      if (t >= track.durationSec) {
        headPos = track.path[track.path.length - 1];
      } else if (t > 0) {
        // Interpolate position.
        for (let i = 1; i < track.timestamps.length; i++) {
          if (t <= track.timestamps[i]) {
            const frac =
              (t - track.timestamps[i - 1]) /
              (track.timestamps[i] - track.timestamps[i - 1]);
            const p0 = track.path[i - 1];
            const p1 = track.path[i];
            headPos = [
              p0[0] + (p1[0] - p0[0]) * frac,
              p0[1] + (p1[1] - p0[1]) * frac,
            ];
            break;
          }
        }
      }

      replayHeads.push({
        position: headPos,
        color: rt.color,
        active,
        finished: t > track.durationSec,
        trackId: track.id,
      });
    }

    // ---- Filler walker heads (fast path — no trails, dots only) -----------
    const tH = state.simSec / 3600;
    const fillerHeads: FillerHead[] = [];
    const nowSimSec = state.simSec;

    for (const w of cohort) {
      const s = snapshotAt(w, route, tH);
      let pos: [number, number];
      let status: "walking" | "finished" | "dnf" | "pre-start" | "bus";

      // VPS3 bus effect: walkers who DNF at VPS3 teleport to finish.
      if (s.status === "dnf" && s.km >= vps3Km - 1 && s.km <= vps3Km + 1) {
        if (!busRiders.has(w.id)) {
          busRiders.set(w.id, nowSimSec);
        }
        const boardTime = busRiders.get(w.id)!;
        const busDelay = 30; // 30 sim-seconds for the bus ride
        if (nowSimSec >= boardTime + busDelay) {
          // Arrived at finish via bus.
          pos = positionAtKm(route, ROUTE_KM);
          status = "bus";
        } else {
          // Still on the bus — freeze at VPS3.
          pos = s.position;
          status = "dnf";
        }
      } else {
        pos = s.position;
        status = s.status;
      }

      const color = waveColor(w.startOffsetMin, 120, 8);
      fillerHeads.push({
        position: pos,
        color,
        bandId: w.bandId,
        status,
      });
    }

    // ---- Update replay sidebar ---------------------------------------------
    for (const track of allTracks) {
      let offsetSec = 0;
      if (replayMode === "time-aligned") {
        offsetSec = (track.startEpochMs - EVENT_START_EPOCH) / 1000;
      }

      const km = kmAtSimSec(track, state.simSec, offsetSec);
      const t = state.simSec - offsetSec;
      const pct = Math.min(100, Math.max(0, (t / track.durationSec) * 100));

      const kmEl = document.querySelector<HTMLElement>(
        `[data-track-km="${track.id}"]`,
      );
      const barEl = document.querySelector<HTMLElement>(
        `[data-track-bar="${track.id}"]`,
      );
      if (kmEl) kmEl.textContent = `${km.toFixed(1)} km`;
      if (barEl) barEl.style.width = `${pct}%`;
    }

    // ---- Layers ------------------------------------------------------------

    // Build layers with user walkers + Schluss/Vor + replay data.
    // Filler cohort is rendered separately (fast ScatterplotLayer).
    const allTrips = [...userTrips, schlussTrip, vorTrip];
    deck.setProps({
      layers: makeLayers(
        route,
        allTrips,
        state.simSec,
        replayTrips,
        replayHeads,
        userWalkerColorIdx,
        fillerHeads,
      ),
    });

    // ---- Stats -------------------------------------------------------------

    statTime.textContent = formatHM(state.simSec);
    statClock.textContent = formatClock(EVENT_START_EPOCH, state.simSec);
    timeDisplay.textContent = formatHM(state.simSec);

    // ---- Scrubber sync ---------------------------------------------------
    const scrubMax = Math.max(
      maxTripTime(replayTrips) + 3600,
      (CUTOFF_HOURS + 2) * 3600,
    );
    timeline.max = String(Math.ceil(scrubMax));
    scrubTotal.textContent = formatHM(scrubMax);
    if (!isScrubbing) {
      timeline.value = String(Math.round(state.simSec));
      scrubLabel.textContent = formatHM(state.simSec);
    }

    if (replayTracks.size > 0 || cohort.length > 0) {
      let active = 0;
      let finished = 0;
      let dnfCount = 0;
      let totalCount = replayTracks.size + cohort.length;

      // Replay track stats
      for (const track of allTracks) {
        let os = 0;
        if (replayMode === "time-aligned") {
          os = (track.startEpochMs - EVENT_START_EPOCH) / 1000;
        }
        const t = state.simSec - os;
        if (t < 0) continue;
        if (t >= track.durationSec) finished++;
        else active++;
      }

      // Cohort stats
      const tHours = state.simSec / 3600;
      for (const w of cohort) {
        const s = snapshotAt(w, route, tHours);
        if (s.status === "walking") active++;
        else if (s.status === "finished") finished++;
        else if (s.status === "dnf") dnfCount++;
      }

      // User walkers
      totalCount += userWalkers.length;
      for (const w of userWalkers) {
        const s = snapshotAt(w, route, tHours);
        if (s.status === "pre-start") continue;
        if (s.status === "walking") active++;
        else if (s.status === "finished") finished++;
        else if (s.status === "dnf") dnfCount++;
      }

      statWalkers.textContent = String(totalCount);
      statActive.textContent = String(active);
      statFinished.textContent = String(finished);
      statDnf.textContent = String(dnfCount);
    } else {
      statWalkers.textContent = "0";
      statActive.textContent = "0";
      statFinished.textContent = "0";
      statDnf.textContent = "0";
    }

    // ---- User walker stats ------------------------------------------------
    for (const w of userWalkers) {
      const s = snapshotAt(w, route, state.simSec / 3600);
      const kmEl = document.getElementById(`uw-km-${w.id}`);
      const statusEl = document.getElementById(`uw-status-${w.id}`);
      if (kmEl) kmEl.textContent = `${s.km.toFixed(1)} km`;
      if (statusEl) {
        const label = statusLabel(s.status);
        const key = s.status === "pre-start" ? "walking" : s.status;
        statusEl.textContent = label;
        statusEl.className = `uw-status ${key}`;
      }
    }

    // ---- Histogram ---------------------------------------------------------
    if (cohort.length > 0 || userWalkers.length > 0 || allTracks.length > 0) {
      updateHistogram(
        histSvg,
        route,
        cohort,
        userWalkers,
        schlusslaeufer,
        vorlaeufer,
        state.simSec / 3600,
        allTracks,
        replayMode,
        replayTrips,
      );
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---- Replay head type -------------------------------------------------------

interface ReplayHead {
  position: [number, number];
  color: [number, number, number];
  active: boolean;
  finished: boolean;
  trackId: string;
}

interface FillerHead {
  position: [number, number];
  color: [number, number, number];
  bandId: number;
  status: "walking" | "finished" | "dnf" | "pre-start" | "bus";
}

// ---- Layer construction ------------------------------------------------------

const BAND_COLORS: Record<number, [number, number, number]> = {
  0: [156, 156, 156], // Beginner — muted gray
  1: [188, 140, 90],  // Comfortable — earth
  2: [102, 153, 204], // Steady — muted blue
  3: [124, 196, 121], // Strong — green
  4: [232, 165, 81],  // Fast — orange
  5: [220, 86, 86],   // Elite — red
};

/** Map a walker's start offset to a wave-based color gradient.
 *  Early waves (warm) → late waves (cool). */
function waveColor(
  startOffsetMin: number,
  startWindowMin: number,
  waveCount: number,
): [number, number, number] {
  const waveIdx = Math.floor(
    (startOffsetMin / (startWindowMin || 1)) * waveCount,
  );
  const t = Math.min(1, Math.max(0, waveIdx / (waveCount - 1 || 1)));
  // Hot (early) → cool (late): red-orange → yellow-green → blue.
  const r = Math.round(255 * (1 - t * 0.7));
  const g = Math.round(180 * (1 - Math.abs(t - 0.5) * 2) + 60);
  const b = Math.round(100 + t * 155);
  return [r, g, b];
}

// Special marker colors
const SCHLUSSLAEUFER_COLOR: [number, number, number] = [255, 200, 50]; // ⚠️ yellow
const VORLAEUFER_COLOR: [number, number, number] = [255, 255, 255];     // ⬜ white

// Bright palette for user-created walkers (distinct from band colors)
const USER_WALKER_COLORS: Array<[number, number, number]> = [
  [0, 255, 255],   // cyan
  [255, 0, 255],   // magenta
  [255, 255, 0],   // yellow
  [0, 255, 128],   // spring green
  [255, 128, 0],   // orange
  [128, 0, 255],   // purple
  [255, 80, 80],   // coral
  [80, 255, 80],   // lime
  [255, 128, 255], // pink
  [128, 255, 255], // aqua
];

function makeLayers(
  route: Route,
  trips: Trip[],
  currentSec: number,
  replayTrips: import("./replay").ReplayTripData[],
  replayHeads: ReplayHead[],
  uwColorIdx: Map<string, number>,
  fillerHeads: FillerHead[],
) {
  const routePath = route.points.map<[number, number]>((p) => [p.lon, p.lat]);

  const layers: Array<
    PathLayer | ScatterplotLayer | TripsLayer<Trip> | TripsLayer<import("./replay").ReplayTripData>
  > = [];

  // Base route.
  layers.push(
    new PathLayer({
      id: "route",
      data: [{ path: routePath }],
      getPath: (d: { path: Array<[number, number]> }) => d.path,
      getColor: [255, 255, 255, 140],
      getWidth: 3,
      widthMinPixels: 2,
    }),
  );

  // ---- Walker color helper ------------------------------------------------
  function walkerColor(trip: Trip): [number, number, number] {
    if (trip.walker.bandId === -1) return SCHLUSSLAEUFER_COLOR;
    if (trip.walker.bandId === -2) return VORLAEUFER_COLOR;
    // User-created walkers get their own bright color.
    if (trip.walker.isReal && trip.walker.bandId >= 0) {
      const ci = uwColorIdx.get(trip.walker.id);
      if (ci !== undefined) {
        return USER_WALKER_COLORS[ci % USER_WALKER_COLORS.length];
      }
    }
    return BAND_COLORS[trip.walker.bandId] ?? [150, 150, 150];
  }

  // Filler walker trails (currently user walkers + Schluss/Vor).
  if (trips.length > 0) {
    layers.push(
      new TripsLayer<Trip>({
        id: "walkers-trail",
        data: trips,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => walkerColor(d),
        opacity: 0.6,
        widthMinPixels: 2,
        jointRounded: true,
        capRounded: true,
        trailLength: 1800,
        currentTime: currentSec,
      }),
    );

    layers.push(
      new ScatterplotLayer<Trip>({
        id: "walker-heads",
        data: trips,
        getPosition: (d: Trip) => {
          const ts = d.timestamps;
          if (currentSec <= ts[0]) return [d.path[0][0], d.path[0][1], 0];
          if (currentSec >= ts[ts.length - 1])
            return [d.path[ts.length - 1][0], d.path[ts.length - 1][1], 0];
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
        getRadius: (d: Trip) => {
          // Schlussläufer and Vorläufer get larger dots.
          if (d.walker.bandId < 0) return 1000;
          return d.walker.isReal ? 600 : 300;
        },
        radiusUnits: "meters",
        radiusMinPixels: 3,
        radiusMaxPixels: 18,
        getFillColor: (d: Trip) => {
          const ts = d.timestamps;
          if (currentSec < ts[0]) return [120, 120, 120, 80];
          if (currentSec >= ts[ts.length - 1]) {
            return d.finishStatus === "dnf" ? [80, 80, 80, 140] : [255, 255, 255, 200];
          }
          const c = walkerColor(d);
          return [c[0], c[1], c[2], 255];
        },
        stroked: true,
        getLineColor: (d: Trip) => {
          if (d.walker.bandId < 0) return [0, 0, 0, 255];
          return d.walker.isReal ? [255, 255, 255, 255] : [0, 0, 0, 0];
        },
        lineWidthMinPixels: 1.5,
      }),
    );
  }

  // ---- Replay layers -------------------------------------------------------
  if (replayTrips.length > 0) {
    // Trail layer for replay tracks.
    layers.push(
      new TripsLayer<import("./replay").ReplayTripData>({
        id: "replay-trail",
        data: replayTrips,
        getPath: (d) => d.path,
        getTimestamps: (d) => d.timestamps,
        getColor: (d) => d.color,
        opacity: 0.75,
        widthMinPixels: 2.5,
        jointRounded: true,
        capRounded: true,
        trailLength: 1800,
        currentTime: currentSec,
      }),
    );

    // Head dots for replay tracks.
    layers.push(
      new ScatterplotLayer<ReplayHead>({
        id: "replay-heads",
        data: replayHeads,
        getPosition: (d) => [d.position[0], d.position[1], 0],
        getRadius: 800,
        radiusUnits: "meters",
        radiusMinPixels: 4,
        radiusMaxPixels: 16,
        getFillColor: (d) => {
          if (!d.active) return [120, 120, 120, 40];
          if (d.finished) return [255, 255, 255, 180];
          return [...d.color, 255];
        },
        stroked: true,
        getLineColor: [255, 255, 255, 200],
        lineWidthMinPixels: 1.5,
      }),
    );
  }

  // ---- Filler walker dots (fast path — no trails) -------------------------
  if (fillerHeads.length > 0) {
    layers.push(
      new ScatterplotLayer<FillerHead>({
        id: "filler-heads",
        data: fillerHeads,
        getPosition: (d) => [d.position[0], d.position[1], 0],
        getRadius: (d) => (d.bandId >= 4 ? 350 : 220),
        radiusUnits: "meters",
        radiusMinPixels: 1.5,
        radiusMaxPixels: 6,
        getFillColor: (d) => {
          if (d.status === "pre-start") return [255, 255, 255, 0];
          if (d.status === "dnf") return [80, 40, 40, 120];
          if (d.status === "bus") return [100, 200, 255, 200]; // blue for bus riders
          if (d.status === "finished") return [200, 200, 200, 120];
          return [...d.color, 160];
        },
        stroked: false,
        opacity: 0.7,
      }),
    );
  }

  return layers;
}

// ---- Histogram of walkers along the route ----------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function updateHistogram(
  svg: SVGSVGElement,
  route: Route,
  cohort: Walker[],
  userWalkers: Walker[],
  schluss: Walker,
  vor: Walker,
  tHours: number,
  _replayTracks: ReplayTrack[],
  replayMode: ReplayMode,
  replayTrips: ReplayTripData[],
) {
  // Bin walkers (cohort + user) into 1-km buckets.
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
  for (const w of userWalkers) tally(w);

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Background route line.
  const baseLine = document.createElementNS(SVG_NS, "rect");
  baseLine.setAttribute("x", "0");
  baseLine.setAttribute("y", "28");
  baseLine.setAttribute("width", "100");
  baseLine.setAttribute("height", "1");
  baseLine.setAttribute("fill", "#30363d");
  svg.appendChild(baseLine);

  // Histogram bars.
  if (maxBin > 0) {
    for (let i = 0; i < ROUTE_KM; i++) {
      if (bins[i] === 0) continue;
      const h = (bins[i] / maxBin) * 24;
      const bar = document.createElementNS(SVG_NS, "rect");
      bar.setAttribute("x", String(i));
      bar.setAttribute("y", String(28 - h));
      bar.setAttribute("width", "0.85");
      bar.setAttribute("height", String(h));
      bar.setAttribute("fill", "#6e7681");
      svg.appendChild(bar);
    }
  }

  // VPS waypoint ticks.
  for (const wp of route.waypoints) {
    const tick = document.createElementNS(SVG_NS, "line");
    tick.setAttribute("x1", String(wp.cumKm));
    tick.setAttribute("y1", "28");
    tick.setAttribute("x2", String(wp.cumKm));
    tick.setAttribute("y2", "33");
    tick.setAttribute("stroke", "#58a6ff");
    tick.setAttribute("stroke-width", "0.6");
    svg.appendChild(tick);
  }

  // Finish marker.
  const finish = document.createElementNS(SVG_NS, "line");
  finish.setAttribute("x1", "100");
  finish.setAttribute("y1", "22");
  finish.setAttribute("x2", "100");
  finish.setAttribute("y2", "33");
  finish.setAttribute("stroke", "#56d364");
  finish.setAttribute("stroke-width", "0.7");
  svg.appendChild(finish);

  // Schlussläufer marker.
  const sSnap = snapshotAt(schluss, route, tHours);
  if (sSnap.status === "walking" || sSnap.status === "finished") {
    const sx = Math.min(100, sSnap.km);
    const sLine = document.createElementNS(SVG_NS, "line");
    sLine.setAttribute("x1", String(sx));
    sLine.setAttribute("y1", "0");
    sLine.setAttribute("x2", String(sx));
    sLine.setAttribute("y2", "28");
    sLine.setAttribute("stroke", "#ffc832");
    sLine.setAttribute("stroke-width", "0.6");
    sLine.setAttribute("stroke-dasharray", "2 2");
    svg.appendChild(sLine);
  }

  // Vorläufer marker.
  const vSnap = snapshotAt(vor, route, tHours);
  if (vSnap.status === "walking" || vSnap.status === "finished") {
    const vx = Math.min(100, vSnap.km);
    const vLine = document.createElementNS(SVG_NS, "line");
    vLine.setAttribute("x1", String(vx));
    vLine.setAttribute("y1", "0");
    vLine.setAttribute("x2", String(vx));
    vLine.setAttribute("y2", "28");
    vLine.setAttribute("stroke", "#ffffff");
    vLine.setAttribute("stroke-width", "0.5");
    vLine.setAttribute("stroke-dasharray", "2 2");
    svg.appendChild(vLine);
  }

  // User walker dots.
  for (const uw of userWalkers) {
    const uSnap = snapshotAt(uw, route, tHours);
    if (uSnap.status === "pre-start" || uSnap.status === "dnf") continue;
    const ux = Math.min(100, uSnap.km);
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(ux));
    dot.setAttribute("cy", "28");
    dot.setAttribute("r", "1.8");
    dot.setAttribute("fill", "#58a6ff");
    dot.setAttribute("stroke", "#0d1117");
    dot.setAttribute("stroke-width", "0.5");
    svg.appendChild(dot);
  }

  // Replay track markers (small colored diamonds).
  for (const rt of replayTrips) {
    let os = 0;
    if (replayMode === "time-aligned") {
      os = (rt.track.startEpochMs - EVENT_START_EPOCH) / 1000;
    }
    const rKm = kmAtSimSec(rt.track, tHours * 3600, os);
    const rx = Math.min(100, (rKm / ROUTE_KM) * 100);
    const c = rt.color;
    const diamond = document.createElementNS(SVG_NS, "polygon");
    const cx = rx, cy = 28, s = 1.5;
    diamond.setAttribute(
      "points",
      `${cx},${cy - s} ${cx + s},${cy} ${cx},${cy + s} ${cx - s},${cy}`,
    );
    diamond.setAttribute("fill", `rgb(${c[0]},${c[1]},${c[2]})`);
    diamond.setAttribute("stroke", "#0d1117");
    diamond.setAttribute("stroke-width", "0.4");
    svg.appendChild(diamond);
  }
}

// ---- User walker creation + persistence -------------------------------------

function createUserWalker(
  id: string,
  name: string,
  bandId: number,
  currentSimSec: number,
): Walker {
  const band = bandById(bandId);
  return {
    id,
    name,
    bandId,
    pace0: band.pace0,
    startOffsetMin: currentSimSec / 60,
    dnfKm: null,
    isReal: true,
  };
}

function loadSavedWalkers(): SavedWalker[] {
  // Migrate old single-walker format to array.
  try {
    const raw = localStorage.getItem("megamarsch-sim:my-walker:v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.name === "string" && typeof parsed?.bandId === "number") {
        const migrated: SavedWalker[] = [
          { id: `uw-${Date.now()}`, name: parsed.name, bandId: parsed.bandId },
        ];
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem("megamarsch-sim:my-walker:v1");
        return migrated;
      }
    }
  } catch { /* fall through */ }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item: unknown) =>
          typeof (item as SavedWalker)?.id === "string" &&
          typeof (item as SavedWalker)?.name === "string" &&
          typeof (item as SavedWalker)?.bandId === "number",
      );
    }
  } catch {
    // fall through
  }
  return [];
}

function statusLabel(s: "pre-start" | "walking" | "finished" | "dnf"): string {
  switch (s) {
    case "pre-start": return "warming up";
    case "walking": return "walking";
    case "finished": return "FINISHED ✓";
    case "dnf": return "DNF";
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
  // Track which walker we're editing (null = adding new).
  // editingWalkerId is set by the caller before calling showSignup.
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

function formatClock(eventStartEpoch: number, simSec: number): string {
  // Munich is CEST (UTC+2) in May. Display local event time.
  const CEST_OFFSET_MS = 2 * 3600 * 1000;
  const d = new Date(eventStartEpoch + simSec * 1000 + CEST_OFFSET_MS);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[d.getUTCDay()];
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${h}:${m}`;
}

function escapeHtml(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Suppress unused-warning for BANDS/SVG_NS — kept for future use.
void BANDS;

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f88;padding:24px">${e.stack ?? e}</pre>`;
});

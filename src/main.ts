// Entry point. Wires:
//   - MapLibre base map
//   - deck.gl Mapbox overlay with PathLayer (route) + TripsLayer + ScatterplotLayer
//   - Unified Participants panel (GPX uploads + generated walkers)
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
  fillMissingRouteSuffix,
  buildReplayTrips,
  maxTripTime,
  kmAtSimSec,
  replayColor,
} from "./replay";
import type { ReplayTrack, ReplayMode, ReplayTripData } from "./replay";
import { EVENT_START_EPOCH } from "./replay";

const STORAGE_KEY = "megamarsch-sim:participants:v1";
const NEXT_COLOR_KEY = "megamarsch-sim:next-color";

interface SavedParticipant {
  kind: "generated" | "gpx";
  id: string;
  name: string;
  // generated
  bandId?: number;
  // gpx
  fileName?: string;
  colorIndex?: number;
  customColor?: [number, number, number] | null;
}

// ---- Participant types ------------------------------------------------------

type Participant =
  | { kind: "generated"; id: string; name: string; walker: Walker; trip: Trip; colorIdx: number }
  | { kind: "gpx"; id: string; name: string; track: ReplayTrack };

// ---- Bootstrap ---------------------------------------------------------------

async function main() {
  const route = await loadRoute();

  // ---- Participants --------------------------------------------------------
  let nextColorIndex = 0;
  const participantMap = new Map<string, Participant>();

  // ---- Schlussläufer & Vorläufer -------------------------------------------
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

  const vps3Km =
    route.waypoints.length >= 3
      ? [...route.waypoints].sort((a, b) => a.cumKm - b.cumKm)[2]?.cumKm ?? 70
      : 70;

  const busRiders = new Map<string, number>();

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

  syncCameras(map, deck);

  // Time loop ----------------------------------------------------------------

  const state = {
    simSec: 0,
    speed: 60,
    paused: false,
    lastFrameMs: performance.now(),
  };

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
  timeline.addEventListener("input", () => {
    isScrubbing = true;
    state.simSec = parseInt(timeline.value, 10);
    scrubLabel.textContent = formatHM(state.simSec);
  });
  timeline.addEventListener("change", () => { isScrubbing = false; });
  timeline.addEventListener("pointerup", () => { isScrubbing = false; });
  timeline.addEventListener("touchend", () => { isScrubbing = false; });

  // Stats panel --------------------------------------------------------------
  const statWalkers = byId<HTMLElement>("stat-walkers");
  const statActive = byId<HTMLElement>("stat-active");
  const statFinished = byId<HTMLElement>("stat-finished");
  const statDnf = byId<HTMLElement>("stat-dnf");
  const statTime = byId<HTMLElement>("stat-time");
  const statClock = byId<HTMLElement>("stat-clock");

  // Replay UI ----------------------------------------------------------------
  const replayInput = byId<HTMLInputElement>("replay-file-input");
  const modeSideBySide = byId<HTMLInputElement>("replay-mode-sbs");
  const modeTimeAligned = byId<HTMLInputElement>("replay-mode-aligned");

  let replayMode: ReplayMode = "side-by-side";
  modeSideBySide.addEventListener("change", () => {
    if (modeSideBySide.checked) replayMode = "side-by-side";
  });
  modeTimeAligned.addEventListener("change", () => {
    if (modeTimeAligned.checked) replayMode = "time-aligned";
  });

  // ---- Add participant modal ----------------------------------------------
  const addModal = byId<HTMLElement>("add-modal");
  const addUploadBtn = byId<HTMLButtonElement>("add-upload-btn");
  const addGenerateBtn = byId<HTMLButtonElement>("add-generate-btn");
  const addCloseBtn = byId<HTMLButtonElement>("add-close-btn");
  const addBtn = byId<HTMLButtonElement>("add-participant-btn");
  const participantList = byId<HTMLElement>("participant-list");

  addBtn.addEventListener("click", () => { addModal.hidden = false; });
  addCloseBtn.addEventListener("click", () => { addModal.hidden = true; });
  addUploadBtn.addEventListener("click", () => {
    addModal.hidden = true;
    replayInput.click();
  });
  addGenerateBtn.addEventListener("click", () => {
    addModal.hidden = true;
    editingWalkerId = null;
    showSignup(null);
  });

  // ---- File upload ---------------------------------------------------------

  replayInput.addEventListener("change", async () => {
    const files = replayInput.files;
    if (!files || files.length === 0) return;

    let added = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const lc2 = file.name.toLowerCase();
      if (!lc2.endsWith(".gpx") && !lc2.endsWith(".gpx.txt") && !lc2.endsWith(".xml")) {
        if (lc2.endsWith(".png") || lc2.endsWith(".jpg") || lc2.endsWith(".jpeg") ||
            lc2.endsWith(".pdf") || lc2.endsWith(".zip")) continue;
      }

      try {
        let track = await parseGpxFile(file, nextColorIndex);
        track = fillMissingRoutePrefix(
          track,
          route.points,
          (km) => positionAtKm(route, km),
        );
        track = fillMissingRouteSuffix(
          track,
          route.points,
          (km) => positionAtKm(route, km),
          ROUTE_KM,
        );
        // Default name from GPX metadata or filename.
        const name = track.name.trim() || file.name.replace(/\.(gpx|gpx\.txt|xml)$/i, "");
        const id = `gpx-${Date.now()}-${i}`;
        const p: Participant = { kind: "gpx", id, name, track };
        participantMap.set(id, p);
        nextColorIndex++;
        added++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errorDiv = byId<HTMLElement>("replay-error");
        errorDiv.textContent = `${file.name}: ${msg}`;
        errorDiv.hidden = false;
        setTimeout(() => { errorDiv.hidden = true; errorDiv.textContent = ""; }, 5000);
      }
    }

    replayInput.value = "";
    if (added > 0) {
      persistParticipants();
      renderParticipants();
    }
  });

  // ---- GPX rename handler -------------------------------------------------

  function gpxRename(id: string) {
    const p = participantMap.get(id);
    if (!p || p.kind !== "gpx") return;
    const oldName = p.name;
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldName;
    input.className = "replay-name-edit";
    input.maxLength = 40;
    const commit = () => {
      const newName = input.value.trim();
      if (newName && newName !== oldName) {
        p.name = newName;
        persistParticipants();
      }
      renderParticipants();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") { input.value = oldName; commit(); }
    });
    const nameEl = document.querySelector(`[data-pname="${id}"]`);
    if (nameEl) nameEl.replaceWith(input);
    input.focus();
    input.select();
  }

  function gpxRemove(id: string) {
    participantMap.delete(id);
    persistParticipants();
    renderParticipants();
  }

  function gpxCycleColor(id: string) {
    const p = participantMap.get(id);
    if (!p || p.kind !== "gpx") return;
    p.track.colorIndex++;
    p.track.customColor = null;
    persistParticipants();
    renderParticipants();
  }

  // ---- Participants list rendering ----------------------------------------

  function renderParticipants() {
    participantList.innerHTML = "";

    if (participantMap.size === 0) {
      participantList.innerHTML =
        '<div class="uw-empty">No participants yet. Click + to add one.</div>';
      return;
    }

    // Sort by current progress (km) descending — leader first.
    const sorted = Array.from(participantMap.values()).sort((a, b) => {
      const aKm = participantKm(a);
      const bKm = participantKm(b);
      return bKm - aKm;
    });

    for (const p of sorted) {
      const color = participantColor(p);
      const colorStr = `rgb(${color[0]},${color[1]},${color[2]})`;
      const row = document.createElement("div");
      row.className = "replay-row";
      row.dataset.pid = p.id;

      if (p.kind === "gpx") {
        row.innerHTML = `
          <span class="replay-swatch" style="background:${colorStr}" data-pswatch="${p.id}" title="Click to cycle color"></span>
          <span class="replay-name" data-pname="${p.id}" title="Click to rename">${escapeHtml(p.name)}</span>
          <span class="replay-km" data-pkm="${p.id}">0.0 km</span>
          <span class="replay-bar-wrap">
            <span class="replay-bar" style="width:0%;background:${colorStr};" data-pbar="${p.id}"></span>
          </span>
          <button class="replay-remove" data-premove="${p.id}" title="Remove">×</button>
        `;
      } else {
        const b = bandById(p.walker.bandId);
        row.innerHTML = `
          <span class="uw-dot" style="background:${colorStr}"></span>
          <span class="uw-name">${escapeHtml(p.name)}</span>
          <span class="uw-band">${b.label}</span>
          <span class="uw-km" data-pkm="${p.id}">0 km</span>
          <span class="uw-status" data-pstatus="${p.id}">—</span>
          <button class="uw-edit" data-pedit="${p.id}" title="Edit">✎</button>
          <button class="uw-remove" data-premove="${p.id}" title="Remove">×</button>
        `;
      }

      participantList.appendChild(row);
    }

    // Wire up GPX interactions.
    participantList.querySelectorAll<HTMLElement>(".replay-swatch").forEach((el) => {
      el.addEventListener("click", () => gpxCycleColor(el.dataset.pswatch!));
    });
    participantList.querySelectorAll<HTMLElement>(".replay-name").forEach((el) => {
      el.addEventListener("click", () => gpxRename(el.dataset.pname!));
    });
    participantList.querySelectorAll<HTMLButtonElement>(".replay-remove").forEach((btn) => {
      btn.addEventListener("click", () => gpxRemove(btn.dataset.premove!));
    });

    // Wire up generated walker interactions.
    participantList.querySelectorAll<HTMLButtonElement>(".uw-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.pedit!;
        const p = participantMap.get(id);
        if (p && p.kind === "generated") {
          editingWalkerId = id;
          showSignup({ id: p.id, name: p.name, bandId: p.walker.bandId });
        }
      });
    });
    participantList.querySelectorAll<HTMLButtonElement>(".uw-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        participantMap.delete(btn.dataset.premove!);
        persistParticipants();
        renderParticipants();
      });
    });
  }

  // ---- Helper: participant km/color ----------------------------------------

  function participantKm(p: Participant): number {
    if (p.kind === "gpx") {
      let os = 0;
      if (replayMode === "time-aligned") {
        os = (p.track.startEpochMs - EVENT_START_EPOCH) / 1000;
      }
      return kmAtSimSec(p.track, state.simSec, os) ?? 0;
    } else {
      const s = snapshotAt(p.walker, route, state.simSec / 3600);
      return s.km;
    }
  }

  function participantColor(p: Participant): [number, number, number] {
    if (p.kind === "gpx") {
      if (p.track.customColor) return p.track.customColor;
      return replayColor(p.track.colorIndex);
    } else {
      if (!(p.colorIdx in USER_WALKER_COLORS)) return [255, 255, 255, 255] as any;
      return USER_WALKER_COLORS[p.colorIdx % USER_WALKER_COLORS.length];
    }
  }

  // ---- Generated walker management -----------------------------------------

  let editingWalkerId: string | null = null;

  function addGeneratedWalker(name: string, bandId: number) {
    const id = `uw-${Date.now()}`;
    void (bandById(bandId)); // validate band exists
    const w = createUserWalker(id, name, bandId, state.simSec);
    const trip = buildTrip(w, route);
    const ci = nextColorIndex++;
    const p: Participant = { kind: "generated", id, name, walker: w, trip, colorIdx: ci };
    participantMap.set(id, p);
    persistParticipants();
    renderParticipants();
  }

  function editGeneratedWalker(id: string, name: string, bandId: number) {
    const p = participantMap.get(id);
    if (!p || p.kind !== "generated") return;
    const band = bandById(bandId);
    p.walker = { ...p.walker, name, bandId, pace0: band.pace0 };
    p.trip = buildTrip(p.walker, route);
    p.name = name;
    persistParticipants();
    renderParticipants();
  }

  setupSignup({
    route,
    onSubmit: (name, bandId) => {
      if (editingWalkerId) {
        editGeneratedWalker(editingWalkerId, name, bandId);
        editingWalkerId = null;
      } else {
        addGeneratedWalker(name, bandId);
      }
    },
  });

  // ---- Persistence ---------------------------------------------------------

  function persistParticipants() {
    const data: SavedParticipant[] = [];
    for (const p of participantMap.values()) {
      if (p.kind === "generated") {
        data.push({ kind: "generated", id: p.id, name: p.name, bandId: p.walker.bandId });
      } else {
        data.push({
          kind: "gpx",
          id: p.id,
          name: p.name,
          colorIndex: p.track.colorIndex,
          customColor: p.track.customColor,
        });
      }
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(NEXT_COLOR_KEY, String(nextColorIndex));
    } catch { /* ignore */ }
  }

  // Load saved participants. GPX ones can't be restored from localStorage
  // (the file data is ephemeral), but generated walkers can.
  function loadSavedParticipants() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const arr: SavedParticipant[] = JSON.parse(raw);
      for (const s of arr) {
        if (s.kind === "generated" && s.bandId != null) {
          const w = createUserWalker(s.id, s.name, s.bandId, 0);
          const trip = buildTrip(w, route);
          const ci = nextColorIndex++;
          participantMap.set(s.id, { kind: "generated", id: s.id, name: s.name, walker: w, trip, colorIdx: ci });
        }
      }
    } catch { /* fall through */ }

    try {
      const ciRaw = localStorage.getItem(NEXT_COLOR_KEY);
      if (ciRaw) nextColorIndex = parseInt(ciRaw, 10) || nextColorIndex;
    } catch { /* fall through */ }
  }

  loadSavedParticipants();
  renderParticipants();

  // ---- Main tick loop ------------------------------------------------------

  function tick() {
    const now = performance.now();
    const dtMs = now - state.lastFrameMs;
    state.lastFrameMs = now;

    if (!state.paused) {
      state.simSec += (dtMs / 1000) * state.speed;

      const gpxTracks = Array.from(participantMap.values())
        .filter((p): p is Participant & { kind: "gpx" } => p.kind === "gpx")
        .map((p) => p.track);
      const replayTrips = buildReplayTrips(gpxTracks, replayMode);
      const maxTime = Math.max(
        maxTripTime(replayTrips) + 3600,
        (CUTOFF_HOURS + 2) * 3600,
      );
      if (state.simSec > maxTime) state.simSec = 0;
    }

    // ---- Build replay data ------------------------------------------------
    const gpxParticipants = Array.from(participantMap.values())
      .filter((p): p is Participant & { kind: "gpx" } => p.kind === "gpx");
    const gpxTracks = gpxParticipants.map((p) => p.track);
    const replayTrips = buildReplayTrips(gpxTracks, replayMode);

    // Replay head positions.
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

    // ---- Filler walker heads -----------------------------------------------
    const tH = state.simSec / 3600;
    const fillerHeads: FillerHead[] = [];
    const nowSimSec = state.simSec;
    for (const w of cohort) {
      const s = snapshotAt(w, route, tH);
      let pos: [number, number];
      let status: "walking" | "finished" | "dnf" | "pre-start" | "bus";
      if (s.status === "dnf" && s.km >= vps3Km - 1 && s.km <= vps3Km + 1) {
        if (!busRiders.has(w.id)) busRiders.set(w.id, nowSimSec);
        const boardTime = busRiders.get(w.id)!;
        const busDelay = 30;
        if (nowSimSec >= boardTime + busDelay) {
          pos = positionAtKm(route, ROUTE_KM);
          status = "bus";
        } else {
          pos = s.position;
          status = "dnf";
        }
      } else {
        pos = s.position;
        status = s.status;
      }
      const color = waveColor(w.startOffsetMin, 120, 8);
      fillerHeads.push({ position: pos, color, bandId: w.bandId, status });
    }

    // ---- Update participant sidebar ----------------------------------------
    // Re-sort DOM rows by current km (descending).
    const sortedIds = Array.from(participantMap.entries())
      .sort(([, a], [, b]) => participantKm(b) - participantKm(a))
      .map(([id]) => id);

    const rowsInDom = participantList.querySelectorAll<HTMLElement>("[data-pid]");
    if (rowsInDom.length === sortedIds.length) {
      for (const id of sortedIds) {
        const row = participantList.querySelector<HTMLElement>(`[data-pid="${id}"]`);
        if (row) participantList.appendChild(row);
      }
    }

    for (const p of participantMap.values()) {
      const km = participantKm(p);
      const kmEl = document.querySelector<HTMLElement>(`[data-pkm="${p.id}"]`);
      if (kmEl) kmEl.textContent = `${km.toFixed(1)} km`;

      const barEl = document.querySelector<HTMLElement>(`[data-pbar="${p.id}"]`);
      if (barEl && p.kind === "gpx") {
        let os = 0;
        if (replayMode === "time-aligned") os = (p.track.startEpochMs - EVENT_START_EPOCH) / 1000;
        const t = state.simSec - os;
        const pct = Math.min(100, Math.max(0, (t / p.track.durationSec) * 100));
        barEl.style.width = `${pct}%`;
      }

      if (p.kind === "generated") {
        const s = snapshotAt(p.walker, route, tH);
        const statusEl = document.querySelector<HTMLElement>(`[data-pstatus="${p.id}"]`);
        if (statusEl) {
          const label = statusLabel(s.status);
          const key = s.status === "pre-start" ? "walking" : s.status;
          statusEl.textContent = label;
          statusEl.className = `uw-status ${key}`;
        }
      }
    }

    // ---- Layers ------------------------------------------------------------
    // Collect generated walker trips (plus Schluss/Vor) for trails.
    const uwTrips: Trip[] = [schlussTrip, vorTrip];
    const uwColorIdx = new Map<string, number>();
    for (const p of participantMap.values()) {
      if (p.kind === "generated") {
        uwTrips.push(p.trip);
        uwColorIdx.set(p.id, p.colorIdx);
      }
    }

    deck.setProps({
      layers: makeLayers(
        route,
        uwTrips,
        state.simSec,
        replayTrips,
        replayHeads,
        uwColorIdx,
        fillerHeads,
      ),
    });

    // ---- Stats -------------------------------------------------------------
    statTime.textContent = formatHM(state.simSec);
    statClock.textContent = formatClock(EVENT_START_EPOCH, state.simSec);
    timeDisplay.textContent = formatHM(state.simSec);

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

    if (participantMap.size > 0 || cohort.length > 0) {
      let active = 0, finished = 0, dnfCount = 0;
      let totalCount = cohort.length;

      // GPX participants
      for (const p of gpxParticipants) {
        let os = 0;
        if (replayMode === "time-aligned") os = (p.track.startEpochMs - EVENT_START_EPOCH) / 1000;
        const t = state.simSec - os;
        if (t < 0) continue;
        if (t >= p.track.durationSec) finished++;
        else active++;
        totalCount++;
      }

      // Cohort stats
      for (const w of cohort) {
        const s = snapshotAt(w, route, tH);
        if (s.status === "walking") active++;
        else if (s.status === "finished") finished++;
        else if (s.status === "dnf") dnfCount++;
      }

      // Generated participants
      for (const p of participantMap.values()) {
        if (p.kind !== "generated") continue;
        totalCount++;
        const s = snapshotAt(p.walker, route, tH);
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

    // ---- Histogram ---------------------------------------------------------
    const allGpxTracks = gpxTracks;
    const generatedWalkers = Array.from(participantMap.values())
      .filter((p): p is Participant & { kind: "generated" } => p.kind === "generated")
      .map((p) => p.walker);

    if (cohort.length > 0 || generatedWalkers.length > 0 || allGpxTracks.length > 0) {
      updateHistogram(
        histSvg,
        route,
        cohort,
        generatedWalkers,
        schlusslaeufer,
        vorlaeufer,
        tH,
        allGpxTracks,
        replayMode,
        replayTrips,
      );
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---- Types -------------------------------------------------------------------

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

// ---- Colors ------------------------------------------------------------------

const BAND_COLORS: Record<number, [number, number, number]> = {
  0: [156, 156, 156],
  1: [188, 140, 90],
  2: [102, 153, 204],
  3: [124, 196, 121],
  4: [232, 165, 81],
  5: [220, 86, 86],
};

function waveColor(
  startOffsetMin: number,
  startWindowMin: number,
  waveCount: number,
): [number, number, number] {
  const waveIdx = Math.floor((startOffsetMin / (startWindowMin || 1)) * waveCount);
  const t = Math.min(1, Math.max(0, waveIdx / (waveCount - 1 || 1)));
  const r = Math.round(255 * (1 - t * 0.7));
  const g = Math.round(180 * (1 - Math.abs(t - 0.5) * 2) + 60);
  const b = Math.round(100 + t * 155);
  return [r, g, b];
}

const SCHLUSSLAEUFER_COLOR: [number, number, number] = [255, 200, 50];
const VORLAEUFER_COLOR: [number, number, number] = [255, 255, 255];

const USER_WALKER_COLORS: Array<[number, number, number]> = [
  [0, 255, 255],
  [255, 0, 255],
  [255, 255, 0],
  [0, 255, 128],
  [255, 128, 0],
  [128, 0, 255],
  [255, 80, 80],
  [80, 255, 80],
  [255, 128, 255],
  [128, 255, 255],
];

// ---- Layer construction ------------------------------------------------------

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

  function walkerColor(trip: Trip): [number, number, number] {
    if (trip.walker.bandId === -1) return SCHLUSSLAEUFER_COLOR;
    if (trip.walker.bandId === -2) return VORLAEUFER_COLOR;
    if (trip.walker.isReal && trip.walker.bandId >= 0) {
      const ci = uwColorIdx.get(trip.walker.id);
      if (ci !== undefined) {
        return USER_WALKER_COLORS[ci % USER_WALKER_COLORS.length];
      }
    }
    return BAND_COLORS[trip.walker.bandId] ?? [150, 150, 150];
  }

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

  // Replay layers.
  if (replayTrips.length > 0) {
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
          if (d.status === "bus") return [100, 200, 255, 200];
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

// ---- Histogram ---------------------------------------------------------------

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

  const baseLine = document.createElementNS(SVG_NS, "rect");
  baseLine.setAttribute("x", "0");
  baseLine.setAttribute("y", "28");
  baseLine.setAttribute("width", "100");
  baseLine.setAttribute("height", "1");
  baseLine.setAttribute("fill", "#30363d");
  svg.appendChild(baseLine);

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

  const finish = document.createElementNS(SVG_NS, "line");
  finish.setAttribute("x1", "100");
  finish.setAttribute("y1", "22");
  finish.setAttribute("x2", "100");
  finish.setAttribute("y2", "33");
  finish.setAttribute("stroke", "#56d364");
  finish.setAttribute("stroke-width", "0.7");
  svg.appendChild(finish);

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

// ---- User walker helpers -----------------------------------------------------

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

function showSignup(prefill: { id: string; name: string; bandId: number } | null) {
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

void BANDS;

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#f88;padding:24px">${e.stack ?? e}</pre>`;
});

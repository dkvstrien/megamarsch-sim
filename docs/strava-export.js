// strava-export.js — Bookmarklet payload.
// Runs in the context of a Strava activity page. Fetches full GPS streams
// via Strava's own API (using the page's auth cookies) and downloads a GPX.
(function () {
  "use strict";

  // Already running?
  if (document.getElementById("__s2g_overlay")) return;

  const activityId = window.location.pathname.split("/").pop();
  if (!activityId || !/^\d+$/.test(activityId)) {
    alert("Not on a Strava activity page. Open an activity and try again.");
    return;
  }

  // Show overlay
  const overlay = document.createElement("div");
  overlay.id = "__s2g_overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.7);" +
    "display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif";
  overlay.innerHTML =
    '<div style="background:#1a1a1a;color:#fff;padding:24px 32px;border-radius:12px;text-align:center;max-width:320px">' +
    '<p style="font-size:16px;margin:0 0 12px">📡 Fetching GPS data…</p>' +
    '<div style="width:100%;height:4px;background:#333;border-radius:2px;overflow:hidden">' +
    '<div id="__s2g_bar" style="width:30%;height:100%;background:#fc4c02;border-radius:2px;transition:width 0.3s"></div>' +
    "</div></div>";
  document.body.appendChild(overlay);

  const bar = document.getElementById("__s2g_bar");

  // Try multiple API endpoints (different response formats).
  async function tryFetch(endpoint) {
    bar.style.width = "50%";
    const resp = await fetch(endpoint, { credentials: "include" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  async function fetchStreams() {
    const endpoints = [
      `/activities/${activityId}/streams?stream_types[]=time&stream_types[]=latlng&stream_types[]=distance&stream_types[]=altitude&key_by_type=true`,
      `/api/v3/activities/${activityId}/streams?keys=time,latlng,distance,altitude&key_by_type=true`,
    ];
    for (const ep of endpoints) {
      try {
        return await tryFetch(ep);
      } catch {
        // try next
      }
    }
    throw new Error("Could not fetch streams. Are you logged into Strava?");
  }

  function unwrap(val) {
    // Handle both {data: [...]} (API v3) and plain arrays (web endpoint).
    return val?.data ?? val ?? [];
  }

  fetchStreams()
    .then(async (streams) => {
      bar.style.width = "80%";
      const latlng = unwrap(streams.latlng);
      const times = unwrap(streams.time);
      const alts = unwrap(streams.altitude);

      if (!latlng || !times) {
        throw new Error("No position or time data in streams");
      }

      const title =
        document.querySelector("h1")?.textContent?.trim() ||
        `activity_${activityId}`;

      // Extract start time from Strava's <time> element.
      // e.g. "2:26 PM on Saturday, May 16, 2026"
      let startDate = null;
      const timeEl = document.querySelector('time');
      if (timeEl) {
        const raw = timeEl.textContent.trim();
        // Parse "2:26 PM on Saturday, May 16, 2026"
        const m = raw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*on\s*\w+,\s*(\w+ \d{1,2}, \d{4})/i);
        if (m) {
          const h = (parseInt(m[1]) % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
          const min = m[2];
          const datePart = m[4];
          startDate = new Date(`${datePart} ${String(h).padStart(2,'0')}:${min}:00`);
        }
      }
      if (!startDate || isNaN(startDate.getTime())) {
        startDate = new Date();
      }

      // Build GPX
      const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx creator="strava-bookmarklet" version="1.1"',
        '  xmlns="http://www.topografix.com/GPX/1/1">',
        "  <trk>",
        `    <name>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</name>`,
        "    <trkseg>",
      ];

      // Determine if times are absolute epochs or relative seconds.
      const timesAreEpochs = typeof times[0] === "number" && times[0] > 1e9;

      for (let i = 0; i < latlng.length; i++) {
        const [lat, lon] = latlng[i];
        const t = timesAreEpochs
          ? new Date(times[i] * 1000)
          : new Date(startDate.getTime() + times[i] * 1000);
        const ts = t.toISOString().replace(".000", "");
        const alt = i < alts.length ? `      <ele>${alts[i].toFixed(1)}</ele>\n` : "";
        lines.push(
          `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}">\n${alt}        <time>${ts}</time>\n      </trkpt>`,
        );
      }

      lines.push("    </trkseg>", "  </trk>", "</gpx>");
      const gpx = lines.join("\n");

      // Download
      const blob = new Blob([gpx], { type: "application/gpx+xml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40)}.gpx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      bar.style.width = "100%";
      overlay.innerHTML =
        '<div style="background:#1a1a1a;color:#fff;padding:24px 32px;border-radius:12px;text-align:center">' +
        `<p style="font-size:18px;margin:0">✅ Downloaded!</p>` +
        `<p style="font-size:13px;color:#8b949e;margin:8px 0 0">${latlng.length} trackpoints in ${title}.gpx</p>` +
        "</div>";
      setTimeout(() => overlay.remove(), 3000);
    })
    .catch((err) => {
      overlay.innerHTML =
        '<div style="background:#1a1a1a;color:#fff;padding:24px 32px;border-radius:12px;text-align:center">' +
        `<p style="font-size:16px;color:#f85149;margin:0">❌ ${err.message}</p>` +
        `<p style="font-size:12px;color:#8b949e;margin:8px 0 0">Make sure you're logged into Strava and viewing your own activity.</p>` +
        "</div>";
      setTimeout(() => overlay.remove(), 5000);
    });
})();

/**
 * Bæovision Radar Replay Card (`custom:rmm-replay-card`)
 * Native Home Assistant Lovelace card for recording, scrubbing, and replaying
 * LD2450 + Radar Map Manager (RMM) floorplan movements over 15m – 48h.
 */

const SVGNS = "http://www.w3.org/2000/svg";
const LOCALE = "en-AU";

const TARGET_COLORS = {
  target_1: "#8CBDB5", // Bæovision Teal
  target_2: "#E6BCB6", // Bæovision Warm Rose
  target_3: "#FFC24B", // Amber
  target_4: "#B4A7D6", // Lavender
  default: "#8CBDB5",
};

// Radar colours come from the rmm_replay `radars:` config (sent with the history);
// radars without one take the next colour from this palette.
const RADAR_PALETTE = ["#5CE1E6", "#FF8A80", "#FFD166", "#B4A7D6", "#8CBDB5", "#F4A261"];

const WINDOWS = [
  { label: "15m", hours: 0.25 },
  { label: "30m", hours: 0.5 },
  { label: "1h", hours: 1 },
  { label: "3h", hours: 3 },
  { label: "6h", hours: 6 },
  { label: "12h", hours: 12 },
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
];

const TRAIL_WINDOWS = [
  { label: "30s", secs: 30 },
  { label: "2m", secs: 120 },
  { label: "10m", secs: 600 },
  { label: "30m", secs: 1800 },
  { label: "Full", secs: 86400 * 2 },
];

const SPEEDS = [1, 2, 5, 15, 60];

class RmmReplayCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._initialized = false;

    // Floorplan & RMM metadata
    this.plan = null;
    this.srcW = 1179;
    this.srcH = 1179;
    this.sx = 1.22;
    this.zones = { include_zones: [], stationary_zones: [], exclude_zones: [] };
    this.radars = {};

    // History & Live state
    this.allFrames = [];
    this.windowFrames = [];
    this.stats = {};
    this.liveTargets = [];
    this.liveRaw = [];
    this.liveConnected = false;
    this._streamUnsub = null;
    this._pollTimer = null;
    this._animRaf = null;
    this._lastTickTime = 0;

    // Playback state
    this.isLive = false;
    this.isPlaying = false;
    this.windowHours = 0.5; // Default 30m view, instant switch to 15m..48h
    this.trailSecs = 120;   // Default 2m trail tail
    this.speed = 5;         // Default 5x playback speed
    this.skipIdle = true;   // Auto-skip dead air > 12s during playback
    this.cursorTs = Date.now() / 1000;
    this.windowStartTs = this.cursorTs - 1800;
    this.windowEndTs = this.cursorTs;

    // Visual layer toggles
    this.showHeatmap = false;
    this.showRawRadars = true;
    this.showZones = false;
    this.showLights = true;

    // DOM Element caches
    this.lampEls = {};
    this._resizeObserver = null;
  }

  static getStubConfig() {
    return { default_window_hours: 0.5 };
  }

  getCardSize() {
    return 12;
  }

  getGridOptions() {
    return { columns: 12, rows: "auto" };
  }

  setConfig(config) {
    const prevHistoryUrl = this._config ? this._config.history_url : null;
    this._config = config || {};
    if (this._config.default_window_hours) {
      this.windowHours = Number(this._config.default_window_hours) || 0.5;
    }
    if (this._config.default_trail_secs) {
      this.trailSecs = Number(this._config.default_trail_secs) || 120;
    }
    if (!this._initialized) {
      this._renderShell();
      this._initialized = true;
      this._initData();
    } else {
      if (this._config.history_url && this._config.history_url !== prevHistoryUrl) {
        this._refreshHistory(true);
      } else {
        this._recomputeWindow(false);
      }
    }
  }

  set hass(hass) {
    const firstHass = !this._hass && hass;
    this._hass = hass;
    if (firstHass) {
      this._subscribeLiveStream();
    }
    if (this._initialized) {
      this._updateLiveEntities();
    }
  }

  connectedCallback() {
    if (!this._initialized) {
      this._renderShell();
      this._initialized = true;
      this._initData();
    }
    if (this._initialized && this._hass && !this._streamUnsub) {
      this._subscribeLiveStream();
    }
    if (!this._pollTimer) {
      this._pollTimer = setInterval(() => this._refreshHistory(false), 8000);
    }
    this._startLoop();
  }

  disconnectedCallback() {
    if (this._streamUnsub) {
      try { this._streamUnsub(); } catch (_) {}
      this._streamUnsub = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._animRaf) {
      cancelAnimationFrame(this._animRaf);
      this._animRaf = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
  }

  $(id) {
    return this.shadowRoot.getElementById(id);
  }

  _el(tag, attrs = {}, parent = null) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  }

  _cropXY(l, t) {
    if (!this.plan || !this.plan.crop) return [l * 11.79 * this.sx, t * 11.79];
    const [cx, cy, cw, ch] = this.plan.crop;
    return [(cx + (l / 100) * cw) * this.sx, cy + (t / 100) * ch];
  }

  _mapXY(xPct, yPct) {
    return [(xPct / 100) * this.srcW * this.sx, (yPct / 100) * this.srcH];
  }

  async _initData() {
    try {
      const r = await fetch("/local/rmm-replay/floorplan.json", { cache: "no-cache" });
      if (r.ok) {
        this.plan = await r.json();
        this.sx = this.plan.x_stretch || 1.22;
        if (this.plan.source_size) {
          this.srcW = this.plan.source_size[0];
          this.srcH = this.plan.source_size[1];
        }
      }
    } catch (e) {
      console.warn("[RMM Replay] floorplan.json fallback:", e);
    }
    this._setupFloorplanSvg();
    await this._refreshHistory(true);
    this._updateLiveEntities();
  }

  _setupFloorplanSvg() {
    const svg = this.$("planSvg");
    const img = this.$("planImg");
    if (!svg || !img) return;

    const view = (this.plan && (this.plan.view || this.plan.crop)) || [22, 22, 1128, 1068];
    const [cx, cy, cw, ch] = view;
    const vbW = cw * this.sx;
    const vbH = ch;
    svg.setAttribute("viewBox", `${cx * this.sx} ${cy} ${vbW} ${vbH}`);
    img.setAttribute("width", this.srcW * this.sx);
    img.setAttribute("height", this.srcH);

    const vig = this.$("planVignette");
    if (vig) {
      vig.setAttribute("x", cx * this.sx);
      vig.setAttribute("y", cy);
      vig.setAttribute("width", vbW);
      vig.setAttribute("height", vbH);
    }

    // Setup canvas overlay matching viewBox coordinates
    const canvas = this.$("trailCanvas");
    if (canvas) {
      canvas.width = Math.round(vbW);
      canvas.height = Math.round(vbH);
      this._vbX = cx * this.sx;
      this._vbY = cy;
      this._vbW = vbW;
      this._vbH = vbH;
    }

    // Render lamps from floorplan.json
    const lampsG = this.$("lampsLayer");
    if (lampsG && this.plan && this.plan.lights) {
      lampsG.replaceChildren();
      this.lampEls = {};
      for (const l of this.plan.lights) {
        const [x, y] = this._cropXY(l.left, l.top);
        const g = this._el("g", { class: "lamp", "data-entity": l.entity_id }, lampsG);
        this._el("circle", { class: "pool", cx: x, cy: y, r: 115 }, g);
        this._el("circle", { class: "bulb", cx: x, cy: y, r: 12 }, g);
        const hit = this._el("circle", { class: "hit", cx: x, cy: y, r: 44 }, g);
        const title = document.createElementNS(SVGNS, "title");
        title.textContent = l.entity_id;
        hit.appendChild(title);
        g.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (this._hass) {
            this._hass.callService("light", "toggle", { entity_id: l.entity_id });
          }
        });
        this.lampEls[l.entity_id] = g;
      }
    }

    // Door lock mark
    const doorG = this.$("doorLayer");
    if (doorG && this.plan && this.plan.door && this.plan.door.position) {
      doorG.replaceChildren();
      const [dx, dy] = this._cropXY(this.plan.door.position[0], this.plan.door.position[1]);
      const g = this._el("g", { class: "lockmark", id: "lockMark", transform: `translate(${dx} ${dy}) scale(1.65)` }, doorG);
      this._el("circle", { class: "lm-bg", r: 30 }, g);
      this._el("rect", { x: -11, y: -3, width: 22, height: 17, rx: 3.5 }, g);
      this._el("path", { id: "lockShackle", d: "M-6.5 -3v-6.5a6.5 6.5 0 0 1 13 0v6.5" }, g);
    }
  }

  _radarColor(rcode) {
    const radars = this.radars || {};
    const info = radars[rcode];
    if (info && info.color) return info.color;
    const idx = Object.keys(radars).sort().indexOf(rcode);
    return RADAR_PALETTE[(idx < 0 ? 0 : idx) % RADAR_PALETTE.length];
  }

  // RMM radar name -> code used in frames (matches the recorder's naming).
  _radarCode(rname) {
    const lower = String(rname).toLowerCase();
    for (const [code, info] of Object.entries(this.radars || {})) {
      if (String(info.name || "").toLowerCase() === lower) return code;
    }
    return rname;
  }

  _drawRadarLegend() {
    const box = this.$("radarLegend");
    if (!box) return;
    box.replaceChildren();
    for (const [rcode, info] of Object.entries(this.radars || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const item = document.createElement("span");
      item.className = "leg";
      const dot = document.createElement("i");
      dot.style.background = this._radarColor(rcode);
      item.append(dot, document.createTextNode(info.label || info.name || rcode));
      box.append(item);
    }
  }

  _drawZonesAndRadarsSvg() {
    this._drawRadarLegend();
    const zonesG = this.$("zonesLayer");
    if (zonesG) {
      zonesG.replaceChildren();
      zonesG.classList.toggle("hidden", !this.showZones);
      const inc = (this.zones && this.zones.include_zones) || [];
      for (const z of inc) {
        const pts = z.points || [];
        if (pts.length < 3) continue;
        const mapped = pts.map(([px, py]) => this._mapXY(px, py));
        const ptsAttr = mapped.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
        const g = this._el("g", { class: "zone-poly", "data-zone": z.name }, zonesG);
        this._el("polygon", { points: ptsAttr }, g);
        const cx = mapped.reduce((s, p) => s + p[0], 0) / mapped.length;
        const cy = mapped.reduce((s, p) => s + p[1], 0) / mapped.length;
        const txt = this._el("text", { x: cx, y: cy, "text-anchor": "middle", "dominant-baseline": "middle" }, g);
        txt.textContent = z.name;
      }
    }

    const radarsG = this.$("radarsLayer");
    if (radarsG) {
      radarsG.replaceChildren();
      radarsG.classList.toggle("hidden", !this.showRawRadars);
      for (const [rcode, rinfo] of Object.entries(this.radars || {})) {
        const layout = rinfo.layout || {};
        const ox = Number(layout.origin_x ?? 50);
        const oy = Number(layout.origin_y ?? 50);
        const rot = Number(layout.rotation ?? 0);
        const [rx, ry] = this._mapXY(ox, oy);
        const col = this._radarColor(rcode);

        const g = this._el("g", { class: "radar-origin", transform: `translate(${rx.toFixed(1)} ${ry.toFixed(1)})` }, radarsG);
        // Subtle 120-deg FOV wedge
        const rad = ((rot - 90) * Math.PI) / 180;
        const fovHalf = (60 * Math.PI) / 180;
        const coneR = 260;
        const x1 = Math.cos(rad - fovHalf) * coneR;
        const y1 = Math.sin(rad - fovHalf) * coneR;
        const x2 = Math.cos(rad + fovHalf) * coneR;
        const y2 = Math.sin(rad + fovHalf) * coneR;
        this._el("path", {
          d: `M 0 0 L ${x1.toFixed(1)} ${y1.toFixed(1)} A ${coneR} ${coneR} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z`,
          fill: col,
          "fill-opacity": "0.055",
          stroke: col,
          "stroke-opacity": "0.22",
          "stroke-width": "2",
          "stroke-dasharray": "6 6",
        }, g);

        this._el("circle", { r: 16, fill: "#1B242D", stroke: col, "stroke-width": "4" }, g);
        this._el("circle", { r: 6, fill: col }, g);
        const lbl = this._el("text", {
          x: 0,
          y: -24,
          "text-anchor": "middle",
          fill: col,
          "font-size": "20",
          "font-weight": "700",
        }, g);
        lbl.textContent = rcode.toUpperCase();
      }
    }
  }

  async _refreshHistory(initial = false) {
    try {
      let data = null;
      if (!this._config.history_url && this._hass && this._hass.connection) {
        try {
          data = await this._hass.callWS({ type: "rmm/history", hours: 48 });
        } catch (_) {
          data = null;
        }
      }
      if (!data) {
        const histUrl = this._config.history_url || "/local/rmm-replay/history_24h.json";
        const resp = await fetch(`${histUrl}?t=${Date.now()}`, { cache: "no-store" });
        if (resp.ok) {
          data = await resp.json();
        }
      }
      if (!data) return;

      this.allFrames = data.frames || [];
      this.stats = data.stats || {};
      const zonesChanged = JSON.stringify(data.zones) !== JSON.stringify(this.zones);
      const radarsChanged = JSON.stringify(data.radars) !== JSON.stringify(this.radars);
      if (data.zones) this.zones = data.zones;
      if (data.radars) this.radars = data.radars;
      if (zonesChanged || radarsChanged || initial) {
        this._drawZonesAndRadarsSvg();
      }

      this._recomputeWindow(initial);
    } catch (e) {
      console.warn("[RMM Replay] history fetch error:", e);
    }
  }

  _subscribeLiveStream() {
    if (!this._hass || !this._hass.connection || this._streamUnsub) return;
    try {
      this._hass.connection
        .subscribeMessage((msg) => this._onStreamEvent(msg), { type: "rmm/stream" })
        .then((unsub) => {
          this._streamUnsub = unsub;
          this.liveConnected = true;
        })
        .catch(() => {});
    } catch (_) {}
  }

  _onStreamEvent(msg) {
    const d = (msg && msg.data) || {};
    const m = (d.maps && d.maps.default) || {};
    const now = Date.now() / 1000;
    const incZones = (this.zones && this.zones.include_zones) || [];
    const excZones = (this.zones && this.zones.exclude_zones) || [];

    const pointInPoly = (x, y, poly) => {
      if (!poly || poly.length < 3) return false;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi;
        if (intersect) inside = !inside;
      }
      return inside;
    };

    const fused = [];
    for (const t of m.targets || []) {
      const srcs = t.sources || [];
      if (srcs.includes("hibernating") || srcs.includes("unverified")) continue;
      if ((t.count || 0) <= 0 && !srcs.includes("hold")) continue;
      if (t.x == null || t.y == null) continue;
      const znames = incZones.filter((z) => pointInPoly(t.x, t.y, z.points)).map((z) => z.name);
      const shortSrcs = srcs.map((s) => {
        const i = s.indexOf(":");
        return i < 0 ? s : `${this._radarCode(s.slice(0, i))}${s.slice(i)}`;
      });
      fused.push({
        id: t.id,
        x: Number(t.x),
        y: Number(t.y),
        s: srcs.includes("hold") ? "hold" : "active",
        src: shortSrcs,
        z: znames.join(" · "),
      });
    }

    const raw = [];
    const rdict = d.radars || {};
    for (const [rname, rconf] of Object.entries(rdict)) {
      if (rconf.paused || (rconf.map_group || "default") !== "default") continue;
      const rcode = this._radarCode(rname);
      const lay = rconf.layout || {};
      for (const rt of rconf.targets || []) {
        const xv = Number(rt.x || 0), yv = Number(rt.y || 0);
        if (!rt.is_1d && Math.abs(xv) < 100 && Math.abs(yv) < 100) continue;
        let xm = xv / 1000, ym = yv / 1000;
        if (lay.mirror_x) xm = -xm;
        const ox = Number(lay.origin_x ?? 50), oy = Number(lay.origin_y ?? 50);
        const sx = Number(lay.scale_x ?? 5), sy = Number(lay.scale_y ?? 5);
        const baseRad = ((Number(lay.rotation ?? 0) - 90) * Math.PI) / 180;
        const yvx = Math.cos(baseRad), yvy = Math.sin(baseRad);
        const xvx = Math.cos(baseRad + Math.PI / 2), xvy = Math.sin(baseRad + Math.PI / 2);
        const fx = ox + xm * sx * xvx + ym * sy * yvx;
        const fy = oy + xm * sx * xvy + ym * sy * yvy;
        if (excZones.some((ez) => pointInPoly(fx, fy, ez.points))) continue;
        raw.push([rcode, Number(rt.i || 1), Number(fx.toFixed(2)), Number(fy.toFixed(2))]);
      }
    }

    this.liveTargets = fused;
    this.liveRaw = raw;
    this.liveConnected = true;

    // Append to in-memory frames if moved so live scrubbing stays immediate
    const last = this.allFrames[this.allFrames.length - 1];
    const moved =
      !last ||
      last.bf ||
      now - last.t >= 0.5 &&
        (fused.length !== (last.f || []).length ||
          fused.some((ft, idx) => {
            const pt = (last.f || [])[idx];
            return !pt || Math.hypot(ft.x - pt.x, ft.y - pt.y) >= 0.16;
          }));

    if (moved) {
      const newFrame = { t: Number(now.toFixed(1)), f: fused, r: raw };
      this.allFrames.push(newFrame);
      if (this.isLive) {
        this.windowEndTs = now;
        this.windowStartTs = now - this.windowHours * 3600;
        this.cursorTs = now;
        this.windowFrames.push(newFrame);
      }
    }
    if (this.isLive) {
      this.cursorTs = now;
      this.windowEndTs = now;
      this.windowStartTs = now - this.windowHours * 3600;
    }
  }

  _updateLiveEntities() {
    if (!this._hass || !this._hass.states) return;
    const states = this._hass.states;
    let lightsOn = 0;
    for (const [eid, g] of Object.entries(this.lampEls)) {
      const st = states[eid];
      const isOn = this.showLights && st && st.state === "on";
      if (st && st.state === "on") lightsOn++;
      g.classList.toggle("on", !!isOn);
      g.classList.toggle("hidden", !this.showLights);
      const pool = g.querySelector(".pool");
      if (pool) {
        const b = st && st.attributes && st.attributes.brightness != null ? st.attributes.brightness : 255;
        pool.style.opacity = isOn ? (0.35 + 0.65 * (b / 255)).toFixed(2) : 0;
      }
    }

    // Door lock
    const lockMark = this.$("lockMark");
    if (lockMark && this.plan && this.plan.door) {
      const lockSt = states[this.plan.door.lock];
      const openSt = states[this.plan.door.contact];
      const isOpen = openSt && openSt.state === "on";
      const isUnlocked = isOpen || (lockSt && lockSt.state !== "locked");
      lockMark.classList.toggle("unlocked", !!isUnlocked);
      const shackle = this.$("lockShackle");
      if (shackle) {
        shackle.setAttribute(
          "d",
          isUnlocked ? "M-6.5 -3v-6.5a6.5 6.5 0 0 1 12.2-2.6" : "M-6.5 -3v-6.5a6.5 6.5 0 0 1 13 0v6.5"
        );
      }
    }

    const lightsBadge = this.$("lightsCountBadge");
    if (lightsBadge) {
      lightsBadge.textContent = `${lightsOn} light${lightsOn === 1 ? "" : "s"} on`;
    }
  }

  _recomputeWindow(initial = false) {
    const now = Date.now() / 1000;
    this.windowEndTs = now;
    this.windowStartTs = now - this.windowHours * 3600;
    this.windowFrames = this.allFrames.filter(
      (fr) => fr.t >= this.windowStartTs - 60 && fr.t <= this.windowEndTs + 5
    );

    if (initial) {
      // Start at the beginning of active movement in the window or 5 mins ago so user can hit Play immediately
      const activeInWin = this.windowFrames.filter((fr) => (fr.f || []).length > 0);
      if (activeInWin.length > 2) {
        this.cursorTs = activeInWin[Math.max(0, activeInWin.length - Math.min(40, activeInWin.length))].t;
      } else {
        this.cursorTs = now;
        this.isLive = true;
      }
    } else if (this.isLive) {
      this.cursorTs = now;
    } else {
      this.cursorTs = Math.max(this.windowStartTs, Math.min(this.windowEndTs, this.cursorTs));
    }

    this._renderActivitySparkline();
    this._renderRoomBreakdown();
    this._renderEventsList();
    this._updateControlsUI();
  }

  _setWindowHours(hours) {
    this.windowHours = hours;
    const now = Date.now() / 1000;
    this.windowEndTs = now;
    this.windowStartTs = now - hours * 3600;
    if (!this.isLive) {
      // Place cursor at first active event in this window or start of window
      const inWin = this.allFrames.filter((fr) => fr.t >= this.windowStartTs && (fr.f || []).length > 0);
      this.cursorTs = inWin.length ? inWin[0].t : this.windowStartTs;
    }
    this._recomputeWindow(false);
  }

  _togglePlay() {
    if (this.isLive) {
      this.isLive = false;
      const inWin = this.windowFrames.filter((fr) => fr.t >= this.windowStartTs && (fr.f || []).length > 0);
      this.cursorTs = inWin.length ? inWin[0].t : this.windowStartTs;
    } else if (this.cursorTs >= this.windowEndTs - 2) {
      this.cursorTs = this.windowStartTs;
    }
    this.isPlaying = !this.isPlaying;
    this._lastTickTime = performance.now();
    this._updateControlsUI();
  }

  _goLive() {
    this.isPlaying = false;
    this.isLive = true;
    const now = Date.now() / 1000;
    this.windowEndTs = now;
    this.windowStartTs = now - this.windowHours * 3600;
    this.cursorTs = now;
    this._updateControlsUI();
  }

  _stepSeconds(deltaSec) {
    this.isLive = false;
    this.isPlaying = false;
    this.cursorTs = Math.max(this.windowStartTs, Math.min(this.windowEndTs, this.cursorTs + deltaSec));
    this._updateControlsUI();
  }

  _jumpToEvent(dir) {
    this.isLive = false;
    this.isPlaying = false;
    const active = this.windowFrames.filter((fr) => (fr.f || []).length > 0);
    if (!active.length) return;
    if (dir < 0) {
      const prev = active.filter((fr) => fr.t < this.cursorTs - 3);
      this.cursorTs = prev.length ? prev[prev.length - 1].t : active[0].t;
    } else {
      const next = active.find((fr) => fr.t > this.cursorTs + 3);
      if (next) this.cursorTs = next.t;
      else this._goLive();
    }
    this._updateControlsUI();
  }

  _startLoop() {
    if (this._animRaf) cancelAnimationFrame(this._animRaf);
    this._lastTickTime = performance.now();
    const step = (nowMs) => {
      const dt = Math.min(0.1, (nowMs - this._lastTickTime) / 1000);
      this._lastTickTime = nowMs;

      if (this.isPlaying && !this.isLive) {
        this.cursorTs += dt * this.speed;

        // If skipIdle is enabled, leap forward over quiet stretches > 15s
        if (this.skipIdle) {
          const idx = this._findFrameIndexAt(this.cursorTs);
          const curr = this.windowFrames[idx];
          const next = this.windowFrames[idx + 1];
          if (curr && next && (next.t - this.cursorTs) > 15 && (curr.f || []).length === 0) {
            this.cursorTs = next.t - 1.0;
          }
        }

        if (this.cursorTs >= this.windowEndTs) {
          this.cursorTs = this.windowEndTs;
          this.isPlaying = false;
          this.isLive = true;
          this._updateControlsUI();
        }
      } else if (this.isLive) {
        const now = Date.now() / 1000;
        this.cursorTs = now;
        this.windowEndTs = now;
        this.windowStartTs = now - this.windowHours * 3600;
      }

      this._renderFrameAt(this.cursorTs);
      this._animRaf = requestAnimationFrame(step);
    };
    this._animRaf = requestAnimationFrame(step);
  }

  _findFrameIndexAt(ts) {
    const arr = this.windowFrames;
    if (!arr.length) return -1;
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (arr[mid].t <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  _interpolateFrameAt(ts) {
    if (this.isLive && this.liveConnected && this.liveTargets.length > 0) {
      return {
        t: ts,
        f: this.liveTargets,
        r: this.liveRaw,
        bf: 0,
      };
    }
    const arr = this.windowFrames;
    if (!arr.length) return { t: ts, f: [], r: [], bf: 0 };
    const idx = this._findFrameIndexAt(ts);
    const f0 = arr[idx];
    const f1 = arr[idx + 1];
    if (!f0) return { t: ts, f: [], r: [], bf: 0 };

    // If gap > 30s and f0 had active targets that vanished, hold only up to 20s
    const age = ts - f0.t;
    if (!f1 || f1.t <= f0.t || f1.t - f0.t > 12) {
      if (age > 45 && (f0.f || []).every((t) => t.s !== "hold")) {
        return { t: ts, f: [], r: [], bf: f0.bf };
      }
      return f0;
    }

    const alpha = Math.max(0, Math.min(1, (ts - f0.t) / (f1.t - f0.t)));
    const f1Map = {};
    for (const t of f1.f || []) f1Map[t.id] = t;

    const interpF = (f0.f || []).map((t0) => {
      const t1 = f1Map[t0.id];
      if (!t1) return t0;
      return {
        ...t0,
        x: t0.x + (t1.x - t0.x) * alpha,
        y: t0.y + (t1.y - t0.y) * alpha,
        z: alpha > 0.5 ? t1.z || t0.z : t0.z,
      };
    });

    return {
      t: ts,
      f: interpF,
      r: f0.r || [],
      bf: f0.bf || 0,
    };
  }

  _renderFrameAt(ts) {
    const frame = this._interpolateFrameAt(ts);
    const canvas = this.$("trailCanvas");
    if (canvas && this._vbW) {
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const toCanvasXY = (xPct, yPct) => {
        const [mx, my] = this._mapXY(xPct, yPct);
        return [mx - this._vbX, my - this._vbY];
      };

      // 1. Optional Occupancy Heatmap
      if (this.showHeatmap) {
        this._drawHeatmapOnCanvas(ctx, toCanvasXY);
      }

      // 2. Historical Movement Trails up to `ts`
      const minTrailTs = Math.max(this.windowStartTs, ts - this.trailSecs);
      const tracksById = {};
      for (let i = 0; i < this.windowFrames.length; i++) {
        const fr = this.windowFrames[i];
        if (fr.t < minTrailTs) continue;
        if (fr.t > ts) break;
        for (const t of fr.f || []) {
          if (!tracksById[t.id]) tracksById[t.id] = [];
          const pts = tracksById[t.id];
          const [cx, cy] = toCanvasXY(t.x, t.y);
          const prev = pts[pts.length - 1];
          if (!prev || Math.hypot(cx - prev.x, cy - prev.y) >= 8) {
            pts.push({ x: cx, y: cy, t: fr.t, bf: !!fr.bf });
          }
        }
      }

      // Append current interpolated target position to end of trail
      for (const t of frame.f || []) {
        if (!tracksById[t.id]) tracksById[t.id] = [];
        const [cx, cy] = toCanvasXY(t.x, t.y);
        tracksById[t.id].push({ x: cx, y: cy, t: ts, bf: !!frame.bf });
      }

      for (const [tid, pts] of Object.entries(tracksById)) {
        if (pts.length < 2) continue;
        const baseCol = TARGET_COLORS[tid] || TARGET_COLORS.default;
        ctx.save();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        for (let i = 1; i < pts.length; i++) {
          const p0 = pts[i - 1];
          const p1 = pts[i];
          // Don't draw straight line across a huge time gap (> 90s) unless adjacent backfill step
          if (p1.t - p0.t > 90 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > 120) continue;

          const ageRatio = this.trailSecs > 86400
            ? 0.25 + 0.75 * (i / pts.length)
            : Math.max(0.08, 1 - (ts - p1.t) / Math.max(10, this.trailSecs));

          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.strokeStyle = baseCol;
          ctx.globalAlpha = 0.65 * ageRatio;
          ctx.lineWidth = 4 + 8 * ageRatio;
          if (p1.bf) {
            ctx.setLineDash([10, 8]);
          } else {
            ctx.setLineDash([]);
          }
          ctx.stroke();

          // Waypoint crumb dot
          if (i % 4 === 0) {
            ctx.beginPath();
            ctx.arc(p1.x, p1.y, 2.5 + 2.5 * ageRatio, 0, Math.PI * 2);
            ctx.fillStyle = "#F1ECEA";
            ctx.globalAlpha = 0.45 * ageRatio;
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 3. Raw LD2450 radar dots & rays
      if (this.showRawRadars && frame.r && frame.r.length) {
        ctx.save();
        for (const [rcode, tIdx, rx, ry] of frame.r) {
          const [cx, cy] = toCanvasXY(rx, ry);
          const col = this._radarColor(rcode);
          const rinfo = (this.radars && this.radars[rcode]) || {};
          if (rinfo.layout) {
            const [ox, oy] = toCanvasXY(Number(rinfo.layout.origin_x ?? 50), Number(rinfo.layout.origin_y ?? 50));
            ctx.beginPath();
            ctx.moveTo(ox, oy);
            ctx.lineTo(cx, cy);
            ctx.strokeStyle = col;
            ctx.globalAlpha = 0.35;
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 6]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.globalAlpha = 0.92;
          ctx.beginPath();
          ctx.arc(cx, cy, 10, 0, Math.PI * 2);
          ctx.fillStyle = col;
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "#1B242D";
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    // 4. Update SVG People Markers
    const peopleG = this.$("peopleLayer");
    if (peopleG) {
      const targets = frame.f || [];
      const existing = {};
      for (const child of Array.from(peopleG.children)) {
        existing[child.dataset.id] = child;
      }
      const seen = new Set();
      for (const t of targets) {
        seen.add(t.id);
        const [x, y] = this._mapXY(t.x, t.y);
        const col = TARGET_COLORS[t.id] || TARGET_COLORS.default;
        let g = existing[t.id];
        if (!g) {
          g = this._el("g", { class: "person", "data-id": t.id }, peopleG);
          this._el("circle", { class: "halo", r: 50, fill: col }, g);
          this._el("circle", { class: "dot", r: 22, fill: col }, g);
          const lbl = this._el("text", {
            class: "ptag",
            x: 0,
            y: -34,
            "text-anchor": "middle",
          }, g);
          lbl.textContent = t.z || t.id.replace("target_", "#");
        }
        g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        g.classList.toggle("hold", t.s === "hold");
        const ptag = g.querySelector(".ptag");
        if (ptag) {
          ptag.textContent = t.z ? t.z.split(" · ").pop() : t.id.replace("target_", "P");
        }
      }
      for (const [id, node] of Object.entries(existing)) {
        if (!seen.has(id)) node.remove();
      }
    }

    // Highlight active zones if zone layer is visible
    if (this.showZones) {
      const activeZ = new Set();
      for (const t of frame.f || []) {
        if (t.z) t.z.split(" · ").forEach((zn) => activeZ.add(zn.trim().toLowerCase()));
      }
      const zonesG = this.$("zonesLayer");
      if (zonesG) {
        for (const zg of zonesG.children) {
          const zn = (zg.dataset.zone || "").toLowerCase();
          zg.classList.toggle("occupied", activeZ.has(zn));
        }
      }
    }

    this._updateReadout(ts, frame);
  }

  _drawHeatmapOnCanvas(ctx, toCanvasXY) {
    if (!this.windowFrames.length) return;
    ctx.save();
    // Grid bucket aggregation so stationary points don't wash out walking paths
    const buckets = new Map();
    for (const fr of this.windowFrames) {
      for (const t of fr.f || []) {
        const bx = Math.round(t.x / 2.5) * 2.5;
        const by = Math.round(t.y / 2.5) * 2.5;
        const key = `${bx},${by}`;
        const weight = t.s === "hold" ? 0.35 : 1.0;
        buckets.set(key, (buckets.get(key) || 0) + weight);
      }
    }
    let maxVal = 1;
    for (const v of buckets.values()) if (v > maxVal) maxVal = v;

    for (const [key, val] of buckets.entries()) {
      const [bx, by] = key.split(",").map(Number);
      const [cx, cy] = toCanvasXY(bx, by);
      const norm = Math.min(1, Math.pow(val / maxVal, 0.45));
      const r = 38 + 42 * norm;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const col = norm > 0.65 ? "255, 194, 75" : norm > 0.35 ? "230, 188, 182" : "140, 189, 181";
      grad.addColorStop(0, `rgba(${col}, ${(0.48 * norm).toFixed(2)})`);
      grad.addColorStop(0.55, `rgba(${col}, ${(0.18 * norm).toFixed(2)})`);
      grad.addColorStop(1, `rgba(${col}, 0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _updateReadout(ts, frame) {
    const d = new Date(ts * 1000);
    const timeStr = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const dateStr = d.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });

    const clockEl = this.$("readoutClock");
    if (clockEl && clockEl.textContent !== timeStr) clockEl.textContent = timeStr;

    const dateEl = this.$("readoutDate");
    if (dateEl) {
      const agoSec = Math.max(0, Math.round(Date.now() / 1000 - ts));
      let agoStr = "LIVE NOW";
      if (!this.isLive && agoSec > 2) {
        if (agoSec < 60) agoStr = `${agoSec}s ago`;
        else if (agoSec < 3600) agoStr = `${Math.floor(agoSec / 60)}m ${agoSec % 60}s ago`;
        else agoStr = `${Math.floor(agoSec / 3600)}h ${Math.floor((agoSec % 3600) / 60)}m ago`;
      }
      const modeTag = frame.bf ? " · Zone History" : " · Exact LD2450 XY";
      const txt = `${dateStr} · ${agoStr}${modeTag}`;
      if (dateEl.textContent !== txt) dateEl.textContent = txt;
    }

    // Update Scrubber progress thumb
    const dur = Math.max(1, this.windowEndTs - this.windowStartTs);
    const pct = Math.max(0, Math.min(100, ((ts - this.windowStartTs) / dur) * 100));
    const fillEl = this.$("scrubberFill");
    const thumbEl = this.$("scrubberThumb");
    if (fillEl) fillEl.style.width = `${pct.toFixed(2)}%`;
    if (thumbEl) thumbEl.style.left = `${pct.toFixed(2)}%`;

    // Update Active Targets list
    const targetsBox = this.$("activeTargetsList");
    if (targetsBox) {
      const targets = frame.f || [];
      const sig = JSON.stringify(targets.map((t) => [t.id, Math.round(t.x), Math.round(t.y), t.s, t.z, t.src])) + JSON.stringify(frame.r || []);
      if (targetsBox.dataset.sig !== sig) {
        targetsBox.dataset.sig = sig;
        if (!targets.length) {
          targetsBox.innerHTML = `<div class="empty-target">No active radar targets at this timestamp</div>`;
        } else {
          targetsBox.innerHTML = targets
            .map((t) => {
              const col = TARGET_COLORS[t.id] || TARGET_COLORS.default;
              const srcBadges = (t.src || [])
                .map((s) => {
                  const rcode = s.split(":")[0];
                  const rcol = this._radarColor(rcode);
                  return `<span class="src-pill" style="border-color:${rcol};color:${rcol}">${s}</span>`;
                })
                .join("");
              return `
                <div class="target-row">
                  <span class="tdot" style="background:${col}"></span>
                  <div class="tinfo">
                    <div class="tmain">
                      <b>${t.z || "Floorplan"}</b>
                      <span class="tstate ${t.s}">${t.s === "hold" ? "Stationary Hold" : "Tracked"}</span>
                    </div>
                    <div class="tsub">
                      <span>X ${t.x.toFixed(1)}% · Y ${t.y.toFixed(1)}%</span>
                      <span class="srcs">${srcBadges}</span>
                    </div>
                  </div>
                </div>`;
            })
            .join("");
        }
      }
    }
  }

  _renderActivitySparkline() {
    const canvas = this.$("sparklineCanvas");
    if (!canvas) return;
    const w = canvas.width = 600;
    const h = canvas.height = 44;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);

    const numBuckets = 150;
    const dur = Math.max(1, this.windowEndTs - this.windowStartTs);
    const bucketSec = dur / numBuckets;
    const buckets = Array.from({ length: numBuckets }, () => ({ active: 0, hold: 0, bf: false }));

    for (let i = 0; i < this.windowFrames.length; i++) {
      const fr = this.windowFrames[i];
      if (fr.t < this.windowStartTs || fr.t > this.windowEndTs) continue;
      const bIdx = Math.min(numBuckets - 1, Math.max(0, Math.floor((fr.t - this.windowStartTs) / bucketSec)));
      const targets = fr.f || [];
      if (!targets.length) continue;
      const hasActive = targets.some((t) => t.s !== "hold");
      if (hasActive) buckets[bIdx].active += 1;
      else buckets[bIdx].hold += 1;
      if (fr.bf) buckets[bIdx].bf = true;
    }

    const maxCount = Math.max(2, ...buckets.map((b) => b.active + b.hold * 0.5));
    const barW = w / numBuckets;

    for (let i = 0; i < numBuckets; i++) {
      const b = buckets[i];
      if (b.active === 0 && b.hold === 0) continue;
      const ratio = Math.min(1, Math.max(0.22, (b.active + b.hold * 0.4) / maxCount));
      const barH = Math.round(ratio * (h - 8));
      const x = i * barW;
      const y = h - barH - 4;
      ctx.fillStyle = b.active > 0 ? (b.bf ? "#6FA39B" : "#8CBDB5") : "#E6BCB6";
      ctx.globalAlpha = b.active > 0 ? 0.85 : 0.45;
      ctx.beginPath();
      ctx.roundRect(x + 0.5, y, Math.max(1.5, barW - 1.2), barH, 2);
      ctx.fill();
    }

    // Update scrubber time axis ticks
    const ticksEl = this.$("scrubberTicks");
    if (ticksEl) {
      const tickCount = 5;
      const html = [];
      for (let i = 0; i <= tickCount; i++) {
        const t = this.windowStartTs + (dur * i) / tickCount;
        const d = new Date(t * 1000);
        const lbl = i === tickCount
          ? "Now"
          : d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
        html.push(`<span>${lbl}</span>`);
      }
      ticksEl.innerHTML = html.join("");
    }
  }

  _renderRoomBreakdown() {
    const box = this.$("roomBreakdown");
    if (!box) return;
    const roomSecs = {};
    let totalOccupiedSecs = 0;

    for (let i = 0; i < this.windowFrames.length; i++) {
      const fr = this.windowFrames[i];
      const nextT = i + 1 < this.windowFrames.length ? this.windowFrames[i + 1].t : this.windowEndTs;
      const dt = Math.min(60, Math.max(0.5, nextT - fr.t));
      const targets = fr.f || [];
      if (!targets.length) continue;
      totalOccupiedSecs += dt;
      const seenZones = new Set();
      for (const t of targets) {
        const z = (t.z || "Lounge").split(" · ")[0];
        seenZones.add(z);
      }
      for (const z of seenZones) {
        roomSecs[z] = (roomSecs[z] || 0) + dt;
      }
    }

    const entries = Object.entries(roomSecs).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      box.innerHTML = `<div class="empty-target">No room occupancy recorded in this window</div>`;
      return;
    }

    const maxS = entries[0][1] || 1;
    box.innerHTML = entries
      .slice(0, 6)
      .map(([room, secs]) => {
        const pct = Math.min(100, Math.round((secs / maxS) * 100));
        const share = totalOccupiedSecs > 0 ? Math.round((secs / totalOccupiedSecs) * 100) : 0;
        const durStr = secs < 60 ? `${Math.round(secs)}s` : secs < 3600 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
        return `
          <div class="room-bar-row" data-room="${room}">
            <div class="room-bar-hdr">
              <span class="rname">${room}</span>
              <span class="rdur">${durStr} <em>(${share}%)</em></span>
            </div>
            <div class="room-bar-track"><i style="width:${pct}%"></i></div>
          </div>`;
      })
      .join("");

    for (const row of box.querySelectorAll(".room-bar-row")) {
      row.addEventListener("click", () => {
        const rm = row.dataset.room;
        const match = [...this.windowFrames].reverse().find((fr) =>
          (fr.f || []).some((t) => (t.z || "").toLowerCase().includes(rm.toLowerCase()))
        );
        if (match) {
          this.isLive = false;
          this.isPlaying = false;
          this.cursorTs = match.t;
          this._updateControlsUI();
        }
      });
    }
  }

  _renderEventsList() {
    const box = this.$("eventsList");
    if (!box) return;
    const transitions = [];
    let lastZoneSig = "";

    for (const fr of this.windowFrames) {
      const targets = fr.f || [];
      if (!targets.length) {
        if (lastZoneSig !== "") lastZoneSig = "";
        continue;
      }
      const zSig = targets.map((t) => t.z || "Floorplan").join(", ");
      if (zSig !== lastZoneSig) {
        lastZoneSig = zSig;
        const srcs = [...new Set(targets.flatMap((t) => t.src || []))].join(", ");
        transitions.push({
          t: fr.t,
          zone: zSig,
          srcs,
          bf: !!fr.bf,
        });
      }
    }

    const recent = transitions.slice(-30).reverse();
    if (!recent.length) {
      box.innerHTML = `<div class="empty-target">No movement transitions in this window</div>`;
      return;
    }

    box.innerHTML = recent
      .map((ev) => {
        const d = new Date(ev.t * 1000);
        const hm = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        return `
          <button class="ev-item" data-ts="${ev.t}">
            <span class="ev-time">${hm}</span>
            <span class="ev-zone">${ev.zone}</span>
            <span class="ev-src">${ev.bf ? "Zone" : ev.srcs || "LD2450"}</span>
          </button>`;
      })
      .join("");

    for (const btn of box.querySelectorAll(".ev-item")) {
      btn.addEventListener("click", () => {
        this.isLive = false;
        this.cursorTs = Number(btn.dataset.ts);
        this.isPlaying = true;
        this._lastTickTime = performance.now();
        this._updateControlsUI();
      });
    }
  }

  _updateControlsUI() {
    for (const btn of this.shadowRoot.querySelectorAll("[data-win]")) {
      btn.classList.toggle("active", Number(btn.dataset.win) === this.windowHours);
    }
    for (const btn of this.shadowRoot.querySelectorAll("[data-trail]")) {
      btn.classList.toggle("active", Number(btn.dataset.trail) === this.trailSecs);
    }
    for (const btn of this.shadowRoot.querySelectorAll("[data-speed]")) {
      btn.classList.toggle("active", Number(btn.dataset.speed) === this.speed);
    }

    const playBtn = this.$("playBtn");
    if (playBtn) {
      playBtn.innerHTML = this.isPlaying
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.5"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>`;
      playBtn.classList.toggle("playing", this.isPlaying);
    }

    const liveBtn = this.$("liveBtn");
    if (liveBtn) {
      liveBtn.classList.toggle("active", this.isLive);
    }

    const skipBtn = this.$("skipIdleBtn");
    if (skipBtn) skipBtn.classList.toggle("active", this.skipIdle);

    const hmBtn = this.$("toggleHeatmapBtn");
    if (hmBtn) hmBtn.classList.toggle("active", this.showHeatmap);

    const rawBtn = this.$("toggleRawBtn");
    if (rawBtn) rawBtn.classList.toggle("active", this.showRawRadars);

    const znBtn = this.$("toggleZonesBtn");
    if (znBtn) znBtn.classList.toggle("active", this.showZones);

    const ltBtn = this.$("toggleLightsBtn");
    if (ltBtn) ltBtn.classList.toggle("active", this.showLights);

    const statsBadge = this.$("storageStatsBadge");
    if (statsBadge && this.stats.total_frames != null) {
      const kb = this.stats.storage_kb ? ` · ${this.stats.storage_kb} KB` : "";
      statsBadge.textContent = `${this.stats.total_frames.toLocaleString()} frames saved (${this.stats.retention_hours || 48}h buffer${kb})`;
    }
  }

  _bindScrubberInteraction() {
    const track = this.$("scrubberTrack");
    if (!track) return;

    let dragging = false;
    const seekFromEvent = (e) => {
      const rect = track.getBoundingClientRect();
      const clientX = e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
      this.isLive = false;
      this.cursorTs = this.windowStartTs + ratio * (this.windowEndTs - this.windowStartTs);
      this._renderFrameAt(this.cursorTs);
      this._updateControlsUI();
    };

    track.addEventListener("pointerdown", (e) => {
      dragging = true;
      track.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });
    track.addEventListener("pointermove", (e) => {
      if (dragging) seekFromEvent(e);
    });
    track.addEventListener("pointerup", (e) => {
      if (dragging) {
        dragging = false;
        try { track.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    });
  }

  _renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        @font-face { font-family: Manrope; src: local("Manrope"), url("/local/rmm-replay/Manrope.ttf") format("truetype"); font-weight: 200 800; }
        @font-face { font-family: Syne; src: local("Syne"), url("/local/rmm-replay/Syne.ttf") format("truetype"); font-weight: 400 800; }

        :host {
          --bg: #1B242D;
          --panel: #243140;
          --panel2: #2D3C4B;
          --line: rgba(255, 255, 255, 0.09);
          --ink: #F1ECEA;
          --mute: #A9BAB6;
          --accent: #8CBDB5;
          --warm: #E6BCB6;
          --amber: #FFC24B;
          --bad: #E37B7B;
          display: block;
          background: var(--bg);
          color: var(--ink);
          font-family: Manrope, system-ui, -apple-system, sans-serif;
          font-variant-numeric: tabular-nums;
          -webkit-font-smoothing: antialiased;
          min-height: calc(100vh - 56px);
          padding: 20px 24px 28px;
          box-sizing: border-box;
          user-select: none;
        }

        * { box-sizing: border-box; margin: 0; }
        .hidden { display: none !important; }

        .shell {
          max-width: 1640px;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }

        /* Header Bar */
        .hdr {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 14px 20px;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .brand-dot {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 12px var(--accent);
        }
        .brand-title {
          font-family: Syne, Manrope, sans-serif;
          font-size: 20px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .brand-title b { color: var(--accent); }
        .brand-sub {
          font-size: 12px;
          color: var(--mute);
          font-weight: 600;
          letter-spacing: 0.04em;
        }

        .hdr-controls {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 12px;
        }
        .pill-group {
          display: inline-flex;
          align-items: center;
          background: #18212A;
          padding: 4px;
          border-radius: 12px;
          border: 1px solid var(--line);
          gap: 2px;
        }
        .pill-lbl {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: var(--mute);
          padding: 0 10px 0 8px;
        }
        button {
          font-family: inherit;
          font-variant-numeric: tabular-nums;
          border: none;
          background: transparent;
          color: var(--mute);
          font-size: 13px;
          font-weight: 700;
          padding: 7px 12px;
          border-radius: 9px;
          cursor: pointer;
          transition: background-color 0.18s ease, color 0.18s ease;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        button:hover {
          color: var(--ink);
          background: rgba(255, 255, 255, 0.06);
        }
        button.active {
          background: var(--accent);
          color: #152028;
        }
        .live-btn {
          background: rgba(140, 189, 181, 0.12);
          color: var(--accent);
          border: 1px solid rgba(140, 189, 181, 0.35);
          padding: 8px 14px;
          border-radius: 12px;
        }
        .live-btn .pulse {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: currentColor;
        }
        .live-btn.active {
          background: var(--accent);
          color: #152028;
          border-color: var(--accent);
        }
        .live-btn.active .pulse {
          animation: livepulse 1.4s ease-in-out infinite;
        }
        @keyframes livepulse { 50% { opacity: 0.25; } }

        /* Main Workspace Grid */
        .main-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.85fr);
          gap: 18px;
          align-items: start;
        }
        @media (max-width: 1024px) {
          .main-grid { grid-template-columns: 1fr; }
        }

        /* Floorplan Stage */
        .stage-card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 22px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .stage-toolbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .layer-toggles {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .layer-btn {
          background: #18212A;
          border: 1px solid var(--line);
          border-radius: 10px;
          padding: 6px 12px;
          font-size: 12px;
        }
        .layer-btn.active {
          background: rgba(140, 189, 181, 0.22);
          color: var(--accent);
          border-color: var(--accent);
        }

        .plan-wrap {
          position: relative;
          width: 100%;
          max-height: calc(100vh - 280px);
          aspect-ratio: 1.288;
          margin: 0 auto;
          background: #18212A;
          border-radius: 16px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }
        .plan-wrap svg,
        .plan-wrap canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
        }
        .plan-wrap canvas {
          pointer-events: none;
          z-index: 2;
        }
        .plan-wrap svg#planSvg { z-index: 1; }
        .plan-wrap svg#peopleSvg { z-index: 3; pointer-events: none; }
        .plan-bg { filter: brightness(0.44) saturate(0.75) contrast(1.06); }
        .vignette { fill: url(#vignetteGrad); pointer-events: none; }

        /* Lamps & Door Lock on Floorplan */
        .lamp .pool { fill: url(#poolGrad); mix-blend-mode: screen; opacity: 0; transition: opacity 0.5s ease; pointer-events: none; }
        .lamp .bulb { fill: none; stroke: var(--mute); stroke-width: 4.5; opacity: 0.4; transition: all 0.4s ease; }
        .lamp.on .bulb { fill: var(--amber); stroke: #FFE3A3; opacity: 1; }
        .lamp .hit { fill: transparent; cursor: pointer; }
        .lockmark .lm-bg { fill: #1B242D; opacity: 0.85; }
        .lockmark rect, .lockmark path { fill: none; stroke: var(--accent); stroke-width: 3.8; stroke-linecap: round; stroke-linejoin: round; }
        .lockmark.unlocked rect, .lockmark.unlocked path { stroke: var(--warm); }

        /* Zones on Floorplan */
        .zone-poly polygon {
          fill: rgba(140, 189, 181, 0.05);
          stroke: rgba(140, 189, 181, 0.35);
          stroke-width: 2.5;
          stroke-dasharray: 8 6;
          transition: fill 0.25s ease, stroke 0.25s ease;
        }
        .zone-poly.occupied polygon {
          fill: rgba(140, 189, 181, 0.18);
          stroke: var(--accent);
          stroke-dasharray: none;
        }
        .zone-poly text {
          fill: var(--ink);
          font-size: 24px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          opacity: 0.65;
          paint-order: stroke;
          stroke: #1B242D;
          stroke-width: 6px;
        }

        /* Tracked People on Floorplan */
        .person .halo {
          opacity: 0.24;
          transform-box: fill-box;
          transform-origin: center;
          animation: breathe 2.4s ease-in-out infinite;
        }
        .person .dot {
          stroke: #1B242D;
          stroke-width: 6;
        }
        .person.hold .dot {
          stroke-dasharray: 8 5;
          fill-opacity: 0.75;
        }
        .person .ptag {
          fill: #F1ECEA;
          font-size: 22px;
          font-weight: 800;
          paint-order: stroke;
          stroke: #1B242D;
          stroke-width: 7px;
          letter-spacing: 0.04em;
        }
        @keyframes breathe { 50% { transform: scale(1.32); opacity: 0.08; } }

        /* Scrubber & Transport Bar */
        .scrubber-panel {
          background: #18212A;
          border: 1px solid var(--line);
          border-radius: 16px;
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .scrubber-track {
          position: relative;
          height: 48px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 10px;
          cursor: pointer;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.08);
          touch-action: none;
        }
        .scrubber-track canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          pointer-events: none;
        }
        .scrubber-fill {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 0%;
          background: rgba(140, 189, 181, 0.14);
          border-right: 2px solid var(--accent);
          pointer-events: none;
        }
        .scrubber-thumb {
          position: absolute;
          top: 50%;
          left: 0%;
          width: 16px;
          height: 36px;
          border-radius: 6px;
          background: var(--ink);
          border: 3px solid #18212A;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.6);
          transform: translate(-50%, -50%);
          pointer-events: none;
        }
        .scrubber-ticks {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
          font-weight: 700;
          color: var(--mute);
          padding: 0 2px;
        }

        .transport-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding-top: 4px;
        }
        .transport-left {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .play-btn {
          width: 46px;
          height: 46px;
          border-radius: 50%;
          background: var(--accent);
          color: #152028;
          padding: 0;
          justify-content: center;
          box-shadow: 0 4px 14px rgba(140, 189, 181, 0.3);
        }
        .play-btn:hover {
          background: #9FD0C8;
          color: #152028;
        }
        .play-btn svg { width: 22px; height: 22px; }
        .step-btn {
          background: var(--panel);
          border: 1px solid var(--line);
          color: var(--ink);
          padding: 8px 11px;
          border-radius: 10px;
          font-size: 12px;
        }

        /* Right Column Cards */
        .side-col {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .info-card {
          background: var(--panel);
          border: 1px solid var(--line);
          border-radius: 20px;
          padding: 18px 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .card-lbl {
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--accent);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .readout-clock {
          font-family: Syne, Manrope, sans-serif;
          font-size: 44px;
          font-weight: 700;
          line-height: 0.95;
          letter-spacing: -0.03em;
          color: var(--ink);
        }
        .readout-date {
          font-size: 13px;
          font-weight: 700;
          color: var(--mute);
        }

        .targets-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 4px;
        }
        .target-row {
          display: flex;
          align-items: center;
          gap: 12px;
          background: #18212A;
          padding: 10px 14px;
          border-radius: 12px;
          border: 1px solid var(--line);
        }
        .tdot {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          flex: none;
        }
        .tinfo {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .tmain {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 14px;
        }
        .tstate {
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--accent);
        }
        .tstate.hold { color: var(--warm); }
        .tsub {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12px;
          color: var(--mute);
        }
        .src-pill {
          font-size: 10px;
          font-weight: 800;
          padding: 1px 6px;
          border-radius: 6px;
          border: 1px solid;
          margin-left: 4px;
          text-transform: uppercase;
        }
        .empty-target {
          font-size: 13px;
          color: var(--mute);
          padding: 8px 0;
        }

        /* Room Occupancy Breakdown */
        .room-bar-row {
          display: flex;
          flex-direction: column;
          gap: 5px;
          padding: 6px 8px;
          border-radius: 8px;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }
        .room-bar-row:hover { background: rgba(255, 255, 255, 0.05); }
        .room-bar-hdr {
          display: flex;
          justify-content: space-between;
          font-size: 13px;
          font-weight: 700;
        }
        .room-bar-hdr .rdur { color: var(--mute); }
        .room-bar-hdr .rdur em { font-style: normal; opacity: 0.7; }
        .room-bar-track {
          height: 6px;
          border-radius: 4px;
          background: #18212A;
          overflow: hidden;
        }
        .room-bar-track i {
          display: block;
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--warm));
          border-radius: 4px;
        }

        /* Recent Transitions Log */
        .events-scroll {
          max-height: 250px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding-right: 4px;
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.16) transparent;
        }
        .events-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .events-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .events-scroll::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.16);
          border-radius: 3px;
        }
        .ev-item {
          width: 100%;
          justify-content: space-between;
          background: #18212A;
          border: 1px solid transparent;
          padding: 8px 12px;
          border-radius: 10px;
          text-align: left;
          font-size: 12px;
        }
        .ev-item:hover {
          border-color: var(--accent);
          background: rgba(140, 189, 181, 0.1);
        }
        .ev-time { color: var(--accent); font-weight: 800; }
        .ev-zone { color: var(--ink); font-weight: 700; flex: 1; margin-left: 10px; }
        .ev-src { color: var(--mute); font-size: 11px; }

        /* Legend Footer */
        .legend-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          font-size: 12px;
          color: var(--mute);
          padding: 0 4px;
        }
        .legend-items {
          display: flex;
          flex-wrap: wrap;
          gap: 14px;
          align-items: center;
        }
        .leg {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .leg i {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          display: inline-block;
        }
      </style>

      <div class="shell">
        <header class="hdr">
          <div class="brand">
            <span class="brand-dot"></span>
            <div>
              <div class="brand-title"><b>BÆO</b>VISION · RADAR REPLAY</div>
              <div class="brand-sub" id="storageStatsBadge">Loading LD2450 & RMM movement history…</div>
            </div>
          </div>

          <div class="hdr-controls">
            <div class="pill-group" role="group" aria-label="Time window">
              <span class="pill-lbl">Window</span>
              ${WINDOWS.map((w) => `<button data-win="${w.hours}">${w.label}</button>`).join("")}
            </div>

            <div class="pill-group" role="group" aria-label="Trail length">
              <span class="pill-lbl">Trail</span>
              ${TRAIL_WINDOWS.map((tw) => `<button data-trail="${tw.secs}">${tw.label}</button>`).join("")}
            </div>

            <button class="live-btn" id="liveBtn" title="Snap to real-time LD2450 stream">
              <span class="pulse"></span>LIVE
            </button>
          </div>
        </header>

        <div class="main-grid">
          <div class="stage-card">
            <div class="stage-toolbar">
              <div class="layer-toggles">
                <button class="layer-btn active" id="toggleRawBtn" title="Show individual LD2450 sensor origins & raw points">LD2450 Sensors</button>
                <button class="layer-btn" id="toggleHeatmapBtn" title="Overlay occupancy density heatmap for selected window">Heatmap</button>
                <button class="layer-btn" id="toggleZonesBtn" title="Show RMM room & stationary zone polygons">RMM Zones</button>
                <button class="layer-btn active" id="toggleLightsBtn" title="Show & toggle floorplan lights">Lights (<span id="lightsCountBadge">0 on</span>)</button>
              </div>
              <div class="legend-items" id="radarLegend"></div>
            </div>

            <div class="plan-wrap" id="planWrap">
              <svg id="planSvg" viewBox="26.84 22 1376.16 1068" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <radialGradient id="poolGrad">
                    <stop offset="0" stop-color="#FFC24B" stop-opacity="0.85"/>
                    <stop offset="0.35" stop-color="#FFB13B" stop-opacity="0.38"/>
                    <stop offset="1" stop-color="#FFB13B" stop-opacity="0"/>
                  </radialGradient>
                  <radialGradient id="vignetteGrad" cx="0.5" cy="0.5" r="0.75">
                    <stop offset="0.6" stop-color="#1B242D" stop-opacity="0"/>
                    <stop offset="1" stop-color="#1B242D" stop-opacity="0.55"/>
                  </radialGradient>
                </defs>
                <image class="plan-bg" id="planImg" href="/local/images/floorplan_cropped.png" x="0" y="0" width="1438.38" height="1179" preserveAspectRatio="none"/>
                <g id="zonesLayer" class="hidden"></g>
                <g id="lampsLayer"></g>
                <rect class="vignette" id="planVignette" x="26.84" y="22" width="1376.16" height="1068"/>
                <g id="radarsLayer"></g>
                <g id="doorLayer"></g>
              </svg>

              <canvas id="trailCanvas"></canvas>

              <svg id="peopleSvg" viewBox="26.84 22 1376.16 1068" preserveAspectRatio="xMidYMid meet">
                <g id="peopleLayer"></g>
              </svg>
            </div>

            <div class="scrubber-panel">
              <div class="scrubber-track" id="scrubberTrack" title="Drag to scrub through recorded movement history">
                <canvas id="sparklineCanvas"></canvas>
                <div class="scrubber-fill" id="scrubberFill"></div>
                <div class="scrubber-thumb" id="scrubberThumb"></div>
              </div>
              <div class="scrubber-ticks" id="scrubberTicks"></div>

              <div class="transport-row">
                <div class="transport-left">
                  <button class="play-btn" id="playBtn" aria-label="Play or Pause">
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
                  </button>
                  <button class="step-btn" id="prevEvBtn" title="Jump to previous movement">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
                    <span>Prev</span>
                  </button>
                  <button class="step-btn" id="stepBackBtn" title="Step back 15 seconds">−15s</button>
                  <button class="step-btn" id="stepFwdBtn" title="Step forward 15 seconds">+15s</button>
                  <button class="step-btn" id="nextEvBtn" title="Jump to next movement">
                    <span>Next</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                  </button>
                </div>

                <div class="hdr-controls">
                  <button class="layer-btn active" id="skipIdleBtn" title="Automatically fast-forward over empty stretches with no movement">Skip Idle</button>
                  <div class="pill-group" role="group" aria-label="Playback speed">
                    <span class="pill-lbl">Speed</span>
                    ${SPEEDS.map((s) => `<button data-speed="${s}">${s}×</button>`).join("")}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <aside class="side-col">
            <div class="info-card">
              <div class="card-lbl">
                <span>Playback Timestamp</span>
                <span>AEDT</span>
              </div>
              <div class="readout-clock" id="readoutClock">--:--:--</div>
              <div class="readout-date" id="readoutDate">Loading…</div>
              <div class="targets-list" id="activeTargetsList"></div>
            </div>

            <div class="info-card">
              <div class="card-lbl">
                <span>Room Occupancy in Window</span>
                <span>Click to Jump</span>
              </div>
              <div id="roomBreakdown"></div>
            </div>

            <div class="info-card">
              <div class="card-lbl">
                <span>Movement Transitions</span>
                <span>Click to Replay</span>
              </div>
              <div class="events-scroll" id="eventsList"></div>
            </div>
          </aside>
        </div>
      </div>
    `;

    // Bind UI controls
    for (const btn of this.shadowRoot.querySelectorAll("[data-win]")) {
      btn.addEventListener("click", () => this._setWindowHours(Number(btn.dataset.win)));
    }
    for (const btn of this.shadowRoot.querySelectorAll("[data-trail]")) {
      btn.addEventListener("click", () => {
        this.trailSecs = Number(btn.dataset.trail);
        this._updateControlsUI();
      });
    }
    for (const btn of this.shadowRoot.querySelectorAll("[data-speed]")) {
      btn.addEventListener("click", () => {
        this.speed = Number(btn.dataset.speed);
        this._updateControlsUI();
      });
    }

    this.$("playBtn").addEventListener("click", () => this._togglePlay());
    this.$("liveBtn").addEventListener("click", () => this._goLive());
    this.$("stepBackBtn").addEventListener("click", () => this._stepSeconds(-15));
    this.$("stepFwdBtn").addEventListener("click", () => this._stepSeconds(15));
    this.$("prevEvBtn").addEventListener("click", () => this._jumpToEvent(-1));
    this.$("nextEvBtn").addEventListener("click", () => this._jumpToEvent(1));

    this.$("skipIdleBtn").addEventListener("click", () => {
      this.skipIdle = !this.skipIdle;
      this._updateControlsUI();
    });
    this.$("toggleHeatmapBtn").addEventListener("click", () => {
      this.showHeatmap = !this.showHeatmap;
      this._updateControlsUI();
    });
    this.$("toggleRawBtn").addEventListener("click", () => {
      this.showRawRadars = !this.showRawRadars;
      this._drawZonesAndRadarsSvg();
      this._updateControlsUI();
    });
    this.$("toggleZonesBtn").addEventListener("click", () => {
      this.showZones = !this.showZones;
      this._drawZonesAndRadarsSvg();
      this._updateControlsUI();
    });
    this.$("toggleLightsBtn").addEventListener("click", () => {
      this.showLights = !this.showLights;
      this._updateLiveEntities();
      this._updateControlsUI();
    });

    this._bindScrubberInteraction();
    this._updateControlsUI();
  }
}

if (!customElements.get("rmm-replay-card")) {
  customElements.define("rmm-replay-card", RmmReplayCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "rmm-replay-card")) {
  window.customCards.push({
    type: "rmm-replay-card",
    name: "Bæovision Radar Replay Card",
    description: "Record, scrub, and replay LD2450 & RMM floorplan movements over 15m – 48h",
    preview: true,
  });
}

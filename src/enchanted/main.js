// Enchanted: magical sparks + a sci-fi HUD that follow your hands.
import {
  createHandLandmarker, startCamera, screenMapper, fingerStates, fingerBends, classifyPose,
  pinchRatio, PoseFilter, dist,
} from "../shared/hands.js";
import { glowSprite } from "../spells/fx.js";

// ---------- Tuning ----------
const MAX_SPARKS = 4500;
const CHARGE_TIME = 0.8;        // seconds of fist to fully charge
const BURST_MIN = 0.3;          // charge needed for opening the hand to release a burst
const MAX_RECORD_S = 60;

const PALETTES = {
  gold:   { swatch: "#ffc95c", hot: "255,246,214", core: "255,206,110", deep: "255,140,40" },
  violet: { swatch: "#a98bff", hot: "246,238,255", core: "196,166,255", deep: "130,80,255" },
  cyan:   { swatch: "#6fe3ff", hot: "232,251,255", core: "130,228,255", deep: "40,150,255" },
  rose:   { swatch: "#ff7aa8", hot: "255,236,244", core: "255,150,190", deep: "255,60,130" },
};
const TIPS = [4, 8, 12, 16, 20];
const LABELLED = new Set([4, 8, 16]);   // tips that get a little number tag (like the HUD in the video)

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("fx");
const ctx = canvas.getContext("2d");
const statusEl = $("status");
const toScreen = screenMapper(video);

let W = 0, H = 0, dpr = 1, vignette = null;
function resize() {
  dpr = Math.min(1.5, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.7)");
}
resize();
window.addEventListener("resize", resize);

// ---------- State ----------
let landmarker = null, modelFailed = false, cameraOn = false, showCam = true, showHud = true, lastVideoTime = -1;
let palette = PALETTES.gold, paletteName = "gold";
const hands = new Map();          // key -> hand state
let sparks = [];                  // { x, y, vx, vy, life, max, w, heat }
let shocks = [];                  // expanding burst rings
let carriers = [];                // glowing heads flowing between two hands
const link = { strength: 0, a: null, b: null, spawn: 0 };
const LINK_RATE = 42;             // strands per second flowing between the hands
let flash = 0;
let clock = 0;

try {
  const saved = localStorage.getItem("handheld.enchanted.color");
  if (saved && PALETTES[saved]) { paletteName = saved; palette = PALETTES[saved]; }
} catch {}

// ---------- UI ----------
const colorsEl = $("colors");
for (const [name, p] of Object.entries(PALETTES)) {
  const b = document.createElement("button");
  b.className = "swatch";
  b.style.background = p.swatch;
  b.title = name[0].toUpperCase() + name.slice(1);
  b.setAttribute("aria-label", b.title + " sparks");
  b.setAttribute("aria-pressed", String(name === paletteName));
  b.onclick = () => setPalette(name);
  colorsEl.appendChild(b);
}
function setPalette(name) {
  paletteName = name; palette = PALETTES[name];
  [...colorsEl.children].forEach((b, i) => b.setAttribute("aria-pressed", String(Object.keys(PALETTES)[i] === name)));
  try { localStorage.setItem("handheld.enchanted.color", name); } catch {}
}
function setHud(on) {
  showHud = on;
  $("hudBtn").setAttribute("aria-pressed", String(on));
  $("hudBtn").title = on ? "Hide sci-fi rings (U)" : "Show sci-fi rings (U)";
  try { localStorage.setItem("handheld.enchanted.hud", on ? "1" : "0"); } catch {}
}
try { if (localStorage.getItem("handheld.enchanted.hud") === "0") setHud(false); } catch {}
$("hudBtn").onclick = () => setHud(!showHud);

function toggleCam() {
  showCam = !showCam;
  $("camBtn").setAttribute("aria-pressed", String(showCam));
  $("camBtn").title = showCam ? "Hide camera (H)" : "Show camera (H)";
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$("camBtn").onclick = toggleCam;
$("fsBtn").onclick = toggleFullscreen;
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "r") toggleRecording();
  if (k === "h") toggleCam();
  if (k === "u") setHud(!showHud);
  if (k === "f") toggleFullscreen();
  const n = Number(k);
  if (n >= 1 && n <= 4) setPalette(Object.keys(PALETTES)[n - 1]);
});

// ---------- Helpers ----------
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const avg = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

function addSpark(s) {
  if (sparks.length >= MAX_SPARKS) sparks.splice(0, sparks.length - MAX_SPARKS + 1);
  s.life = 0;
  sparks.push(s);
}

function newHand() {
  return {
    palm: null, vel: { x: 0, y: 0 }, size: 60, angle: 0, open: 0, vis: 0,
    phase: rand(0, Math.PI * 2), charge: 0, pose: null, filter: new PoseFilter(3),
    tips: [], bends: [0, 0, 0, 0], pinch: 1, seen: true, lastBurst: -10, pulse: 0,
    pinching: false, pinchAmt: 0, pinchPt: null,
  };
}

// ---------- Hand processing ----------
function processHands(res, now) {
  for (const h of hands.values()) h.seen = false;
  const n = res?.landmarks?.length || 0;
  const VW = video.videoWidth || 1280, VH = video.videoHeight || 720;
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const lm = res.landmarks[i];
    let key = res.handedness?.[i]?.[0]?.categoryName ?? String(i);
    if (used.has(key)) key += i;
    used.add(key);
    let h = hands.get(key);
    if (!h) { h = newHand(); hands.set(key, h); }
    h.seen = true;

    const world = res.worldLandmarks?.[i] || null;
    const P = (j) => toScreen(lm[j]);
    const base = avg([0, 5, 9, 13, 17].map(P));
    const m9 = P(9);
    const palm = { x: lerp(base.x, m9.x, 0.25), y: lerp(base.y, m9.y, 0.25) };
    const size = Math.max(24, dist(P(0), m9));

    if (h.palm && h.lastT) {
      const dt = Math.max(0.008, (now - h.lastT) / 1000);
      const ix = (palm.x - h.palm.x) / dt, iy = (palm.y - h.palm.y) / dt;
      h.vel.x = lerp(h.vel.x, ix, 0.45);
      h.vel.y = lerp(h.vel.y, iy, 0.45);
    }
    h.lastT = now;
    h.palm = palm;
    h.size = lerp(h.size, size, 0.5);
    const w0 = P(0);
    h.angle = Math.atan2(m9.y - w0.y, m9.x - w0.x) + Math.PI / 2;
    h.tips = TIPS.map(P);

    const f = fingerStates(lm, VW, VH, world);
    h.bends = fingerBends(lm, VW, VH, world);
    h.pinch = pinchRatio(lm, VW, VH);
    h.pose = h.filter.update(classifyPose(f));
    const t4 = P(4), t8 = P(8);
    h.pinchPt = { x: (t4.x + t8.x) / 2, y: (t4.y + t8.y) / 2 };
    // 🤌 pinched fingers: tips together but the fingers point forward (a fist also brings them close)
    h.pinching = h.pinch < (h.pinching ? 0.45 : 0.33) && f[0] !== "curl" && h.pose !== "fist";
    const openNow = f.filter((s) => s === "ext").length / 4;
    h.open = lerp(h.open, openNow, 0.3);

    // ✊ charge -> ✋ release
    if (h.pose === "fist" && !h.pinching) {
      h.charge = Math.min(1, h.charge + 1 / 30 / CHARGE_TIME);
    } else if (h.charge > BURST_MIN && h.open > 0.5) {
      burst(h, h.charge);
      h.charge = 0;
    } else {
      h.charge = Math.max(0, h.charge - 0.02);
    }
  }
}

// Where the spark orbits sit: around the palm, or tight around thumb + index when pinching 🤌
function orbitFrame(h) {
  const k = h.pinchAmt;
  const R0 = h.size * (0.95 + 0.25 * h.open) * (1 - 0.7 * h.charge);
  const c = h.pinchPt && k > 0 ? { x: lerp(h.palm.x, h.pinchPt.x, k), y: lerp(h.palm.y, h.pinchPt.y, k) } : h.palm;
  return { cx: c.x, cy: c.y, R: lerp(R0, h.size * 0.34, k), flat: lerp(0.42, 0.85, k), cross: lerp(0.95, 1.25, k) };
}
function orbitPoint(h, of, k) {
  const a = h.phase + k * Math.PI, tilt = h.angle + (k ? of.cross : -of.cross);
  const lx = Math.cos(a) * of.R, ly = Math.sin(a) * of.R * of.flat;
  return {
    a, tilt,
    x: of.cx + lx * Math.cos(tilt) - ly * Math.sin(tilt),
    y: of.cy + lx * Math.sin(tilt) + ly * Math.cos(tilt),
  };
}

// ---------- Two hands: a tangle of energy flowing between them ----------
// Each strand takes its own random path (S-curves, wiggles, little curls) in either
// direction, so together they fill the space between the hands like a ball of energy.
const linkedAmount = (h) => (h === link.a || h === link.b ? link.strength : 0);

function strandPoint(c, u) {
  const from = c.from, to = c.to;
  const dx = to.palm.x - from.palm.x, dy = to.palm.y - from.palm.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d, nx = -uy, ny = ux;
  const span = Math.max(from.size, to.size);
  // start/end spread over the palms, not one single point
  const p0 = { x: from.palm.x + ux * from.size * 0.35 + nx * c.s0 * from.size, y: from.palm.y + uy * from.size * 0.35 + ny * c.s0 * from.size };
  const p3 = { x: to.palm.x - ux * to.size * 0.35 + nx * c.s1 * to.size, y: to.palm.y - uy * to.size * 0.35 + ny * c.s1 * to.size };
  const c1 = { x: lerp(p0.x, p3.x, 0.33) + nx * c.o1 * span, y: lerp(p0.y, p3.y, 0.33) + ny * c.o1 * span };
  const c2 = { x: lerp(p0.x, p3.x, 0.66) + nx * c.o2 * span, y: lerp(p0.y, p3.y, 0.66) + ny * c.o2 * span };
  const v = 1 - u;
  let x = v * v * v * p0.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * p3.x;
  let y = v * v * v * p0.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * p3.y;
  const taper = Math.sin(Math.PI * u);
  const w = Math.sin(u * Math.PI * 2 * c.freq + c.ph + clock * c.drift) * c.amp * span * taper;
  x += nx * w; y += ny * w;
  if (c.curl) {
    const th = u * Math.PI * 2 * c.turns + c.ph;
    x += Math.cos(th) * c.curl * span * taper;
    y += Math.sin(th) * c.curl * span * taper;
  }
  return { x, y };
}

function newCarrier(from, to) {
  return {
    from, to, u: 0, dur: rand(0.55, 1.15),
    s0: rand(-0.45, 0.45), s1: rand(-0.45, 0.45),
    o1: rand(-2.1, 2.1), o2: rand(-2.1, 2.1),
    amp: rand(0, 0.35), freq: rand(0.6, 2.4), ph: rand(0, Math.PI * 2), drift: rand(-3, 3),
    curl: Math.random() < 0.35 ? rand(0.12, 0.3) : 0, turns: rand(1, 3) * (Math.random() < 0.5 ? -1 : 1),
    x: undefined, y: undefined, trail: [],
  };
}

function updateLink(dt) {
  const seen = [...hands.values()].filter((h) => h.seen && h.palm);
  let want = 0, A = null, B = null;
  if (seen.length === 2) {
    [A, B] = seen[0].palm.x <= seen[1].palm.x ? seen : [seen[1], seen[0]];   // A = left on screen
    const d = dist(A.palm, B.palm);
    const ok = A.open > 0.5 && B.open > 0.5 && A.charge < 0.2 && B.charge < 0.2 && d > (A.size + B.size) * 0.9;
    want = ok ? 1 : 0;
  }
  link.strength = want ? Math.min(1, link.strength + dt * 2.5) : Math.max(0, link.strength - dt * 3);
  if (A && B) { link.a = A; link.b = B; }

  if (link.strength > 0.05 && link.a?.seen && link.b?.seen) {
    link.spawn += dt * LINK_RATE * link.strength;
    while (link.spawn >= 1) {
      link.spawn--;
      carriers.push(Math.random() < 0.5 ? newCarrier(link.a, link.b) : newCarrier(link.b, link.a));
    }
  }

  for (const c of carriers) {
    if (!c.from.seen || !c.to.seen || !c.from.palm || !c.to.palm) {
      // a hand left: the carrier fizzles out where it is
      for (let i = 0; i < 6; i++) addSpark({ x: c.x, y: c.y, vx: rand(-80, 80), vy: rand(-80, 80), max: rand(0.3, 0.6), w: rand(1, 2), heat: 0.3 });
      c.dead = true;
      continue;
    }
    c.u += dt / c.dur;
    const p = strandPoint(c, Math.min(1, c.u));
    const px = c.x ?? p.x, py = c.y ?? p.y;
    c.x = p.x; c.y = p.y;
    c.trail.push({ x: c.x, y: c.y });
    if (c.trail.length > 16) c.trail.shift();
    // a few sparks shed along the strand
    const n = 1;
    for (let i = 0; i < n; i++) {
      const k = i / n;
      addSpark({
        x: lerp(px, c.x, k) + rand(-2, 2), y: lerp(py, c.y, k) + rand(-2, 2),
        vx: rand(-25, 25), vy: rand(-25, 25), max: rand(0.25, 0.55), w: rand(1, 2.2), heat: rand(0, 0.3),
      });
    }
    if (c.u >= 1) {
      c.dead = true;
      c.to.pulse = Math.min(1, c.to.pulse + 0.25);
      for (let i = 0; i < 8; i++) {
        const a = rand(0, Math.PI * 2), v = rand(40, 160);
        addSpark({ x: c.x, y: c.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rand(0.25, 0.5), w: rand(1, 2), heat: 0 });
      }
    }
  }
  carriers = carriers.filter((c) => !c.dead);
  for (const h of hands.values()) h.pulse = Math.max(0, h.pulse - dt * 2.5);
}


function burst(h, power) {
  const { x, y } = h.palm;
  const n = Math.round(260 + 520 * power);
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2);
    const v = rand(120, 380 + 900 * power);
    addSpark({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, max: rand(0.6, 1.4), w: rand(1.2, 2.8), heat: rand(0, 0.5) });
  }
  for (let i = 0; i < 4; i++) {
    shocks.push({ x, y, r0: h.size * 0.8, r1: h.size * (2.4 + 3 * power) * (1 + i * 0.22), t: -i * 0.07, dur: 0.95 });
  }
  flash = Math.min(0.45, 0.15 + 0.3 * power);
}

// ---------- Simulation ----------
function update(dt) {
  clock += dt;
  for (const [key, h] of hands) {
    h.vis = h.seen ? Math.min(1, h.vis + dt * 5) : Math.max(0, h.vis - dt * 3);
    if (!h.seen && h.vis === 0) { hands.delete(key); continue; }
    if (!h.palm) continue;
    const speed = Math.hypot(h.vel.x, h.vel.y);
    h.pinchAmt = h.seen && h.pinching ? Math.min(1, h.pinchAmt + dt * 6) : Math.max(0, h.pinchAmt - dt * 4);
    h.phase += dt * (3.4 + h.charge * 7 + h.pinchAmt * 6 + Math.min(4, speed / 400));
    if (!h.seen) continue;

    // Two crossing orbits around the palm, like the video's swirls
    // (they fade out while this hand is linked to the other one)
    const orbitAmt = 1 - linkedAmount(h);
    const of = orbitFrame(h);
    const R = of.R;
    for (let k = 0; k < 2; k++) {
      const op = orbitPoint(h, of, k);
      const a = op.a, tilt = op.tilt;
      const ex = op.x, ey = op.y;
      const tx = -Math.sin(a) * R, ty = Math.cos(a) * R * of.flat;
      const tl = Math.hypot(tx, ty) || 1;
      const ux = (tx * Math.cos(tilt) - ty * Math.sin(tilt)) / tl;
      const uy = (tx * Math.sin(tilt) + ty * Math.cos(tilt)) / tl;
      const count = Math.round((7 + Math.min(12, speed / 110) + h.charge * 8 + h.pinchAmt * 4) * orbitAmt);
      for (let i = 0; i < count; i++) {
        const sp = rand(15, 70);
        addSpark({
          x: ex + rand(-3, 3), y: ey + rand(-3, 3),
          vx: ux * sp + rand(-30, 30) - h.vel.x * 0.04, vy: uy * sp + rand(-30, 30) - h.vel.y * 0.04,
          max: h.charge > 0.2 ? rand(0.18, 0.4) : rand(0.35, 0.85), w: rand(1.1, 2.3), heat: rand(0, 0.4),
        });
      }
    }

    // Moving fast: sparkler trail off the fingertips
    if (speed > 220 && h.tips.length) {
      const extra = Math.min(9, Math.round((speed - 220) / 90));
      for (const j of [1, 2]) {
        const t = h.tips[j];
        for (let i = 0; i < extra; i++) {
          addSpark({ x: t.x + rand(-4, 4), y: t.y + rand(-4, 4), vx: -h.vel.x * 0.12 + rand(-50, 50), vy: -h.vel.y * 0.12 + rand(-50, 50), max: rand(0.3, 0.7), w: rand(1, 2), heat: rand(0.2, 0.6) });
        }
      }
    }
  }

  updateLink(dt);

  const drag = Math.pow(0.12, dt);
  for (const s of sparks) {
    s.life += dt / s.max;
    s.vx *= drag; s.vy *= drag;
    s.vy += 22 * dt;
    s.x += s.vx * dt; s.y += s.vy * dt;
  }
  sparks = sparks.filter((s) => s.life < 1);
  for (const r of shocks) r.t += dt;
  shocks = shocks.filter((r) => r.t < r.dur);
  flash = Math.max(0, flash - dt * 1.4);
}

// ---------- Rendering ----------
function drawBackground() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (showCam && cameraOn && video.readyState >= 2) {
    const VW = video.videoWidth, VH = video.videoHeight;
    const s = Math.max(W / VW, H / VH);
    const ox = (W - VW * s) / 2, oy = (H - VH * s) / 2;
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);              // mirror like a selfie camera
    ctx.drawImage(video, ox, oy, VW * s, VH * s);
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, 0, W, H);
  }
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

function drawSparks() {
  // Batch streaks into a few paths (by colour band and brightness) so thousands stay cheap
  const bands = [palette.hot, palette.core, palette.deep];
  const paths = Array.from({ length: 12 }, () => new Path2D());
  const widths = new Array(12).fill(0), counts = new Array(12).fill(0);
  for (const s of sparks) {
    const age = s.life + s.heat * 0.5;
    const band = age < 0.25 ? 0 : age < 0.65 ? 1 : 2;
    const fade = Math.pow(1 - s.life, 0.7);
    const ab = Math.min(3, Math.floor((1 - fade) * 4));
    const idx = band * 4 + ab;
    let dx = s.vx * 0.035, dy = s.vy * 0.035;
    const len = Math.hypot(dx, dy);
    if (len > 12) { dx *= 12 / len; dy *= 12 / len; }
    else if (len < 1.5) { dx = 1; dy = 0.6; }
    paths[idx].moveTo(s.x - dx, s.y - dy);
    paths[idx].lineTo(s.x, s.y);
    widths[idx] += s.w; counts[idx]++;
  }
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  for (let i = 0; i < 12; i++) {
    if (!counts[i]) continue;
    const band = Math.floor(i / 4), ab = i % 4;
    ctx.strokeStyle = `rgba(${bands[band]},${[1, 0.8, 0.52, 0.28][ab]})`;
    ctx.lineWidth = widths[i] / counts[i];
    ctx.stroke(paths[i]);
  }
  // warm haze around young sparks, so the streams glow instead of looking like dots
  const haze = glowSprite(palette.deep);
  for (let i = 0; i < sparks.length; i += 3) {
    const s = sparks[i];
    if (s.life > 0.45) continue;
    const g = s.w * 9;
    ctx.globalAlpha = 0.2 * (1 - s.life / 0.45);
    ctx.drawImage(haze, s.x - g / 2, s.y - g / 2, g, g);
  }
  ctx.globalAlpha = 1;
  // soft energy field filling the space between linked hands
  if (link.strength > 0.02 && link.a?.palm && link.b?.palm) {
    const A = link.a.palm, B = link.b.palm;
    const d = dist(A, B), span = Math.max(link.a.size, link.b.size);
    ctx.save();
    ctx.translate((A.x + B.x) / 2, (A.y + B.y) / 2);
    ctx.rotate(Math.atan2(B.y - A.y, B.x - A.x));
    const fw = d * 0.95, fh = span * 3 * (1 + Math.sin(clock * 3) * 0.04);
    ctx.globalAlpha = 0.22 * link.strength;
    ctx.drawImage(glowSprite(palette.deep), -fw / 2, -fh / 2, fw, fh);
    ctx.globalAlpha = 0.12 * link.strength;
    ctx.drawImage(glowSprite(palette.core), -fw / 4, -fh / 4, fw / 2, fh / 2);
    ctx.restore();
  }
  // strands: each one a continuous glowing line with a tail, so together they read as tangled energy
  if (carriers.length) {
    const tail = new Path2D(), body = new Path2D();
    for (const c of carriers) {
      const t = c.trail;
      if (t.length < 2) continue;
      const mid = Math.floor(t.length / 2);
      tail.moveTo(t[0].x, t[0].y);
      for (let i = 1; i <= mid; i++) tail.lineTo(t[i].x, t[i].y);
      body.moveTo(t[mid].x, t[mid].y);
      for (let i = mid + 1; i < t.length; i++) body.lineTo(t[i].x, t[i].y);
    }
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = link.strength;
    ctx.strokeStyle = `rgba(${palette.deep},0.22)`; ctx.lineWidth = 7; ctx.stroke(body);
    ctx.strokeStyle = `rgba(${palette.core},0.35)`; ctx.lineWidth = 1.4; ctx.stroke(tail);
    ctx.strokeStyle = `rgba(${palette.core},0.55)`; ctx.lineWidth = 2.6; ctx.stroke(body);
    ctx.strokeStyle = `rgba(${palette.hot},0.95)`; ctx.lineWidth = 1.1; ctx.stroke(body);
    ctx.globalAlpha = 1;
  }
  // strand heads
  for (const c of carriers) {
    if (c.x === undefined) continue;
    const g = (c.from.size * 0.18) * (0.7 + 0.5 * Math.sin(c.u * Math.PI));
    ctx.globalAlpha = 0.8 * link.strength + 0.2;
    ctx.drawImage(glowSprite(palette.core), c.x - g / 2, c.y - g / 2, g, g);
    ctx.globalAlpha = 0.9;
    ctx.drawImage(glowSprite(palette.hot), c.x - g / 6, c.y - g / 6, g / 3, g / 3);
  }
  for (const h of hands.values()) {
    if (!h.palm || h.pulse <= 0) continue;
    const g = h.size * (1.4 + h.pulse);
    ctx.globalAlpha = 0.45 * h.pulse;
    ctx.drawImage(glowSprite(palette.core), h.palm.x - g / 2, h.palm.y - g / 2, g, g);
  }
  ctx.globalAlpha = 1;
  // soft bloom on the orbit heads and the charge ball
  for (const h of hands.values()) {
    if (!h.palm || !h.seen) continue;
    const orbitAmt = 1 - linkedAmount(h);
    const of = orbitFrame(h);
    for (let k = 0; k < 2; k++) {
      const { x, y } = orbitPoint(h, of, k);
      const g = h.size * lerp(0.55, 0.4, h.pinchAmt);
      ctx.globalAlpha = 0.55 * h.vis * orbitAmt;
      ctx.drawImage(glowSprite(palette.core), x - g / 2, y - g / 2, g, g);
    }
    if (h.pinchAmt > 0.05 && h.pinchPt) {
      const g = h.size * 0.7 * h.pinchAmt * (1 + Math.sin(clock * 12) * 0.08);
      ctx.globalAlpha = 0.6 * h.pinchAmt;
      ctx.drawImage(glowSprite(palette.core), h.pinchPt.x - g / 2, h.pinchPt.y - g / 2, g, g);
    }
    if (h.charge > 0.05) {
      const g = h.size * (0.8 + 2.4 * h.charge) * (1 + Math.sin(clock * 30) * 0.05);
      ctx.globalAlpha = 0.35 + 0.5 * h.charge;
      ctx.drawImage(glowSprite(palette.core), h.palm.x - g / 2, h.palm.y - g / 2, g, g);
      const c = g * 0.35;
      ctx.globalAlpha = h.charge;
      ctx.drawImage(glowSprite(palette.hot), h.palm.x - c / 2, h.palm.y - c / 2, c, c);
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawHud(h) {
  if (!h.palm || h.vis <= 0) return;
  const { x, y } = h.palm;
  const t = clock;
  const a = 0.85 * h.vis * (1 - 0.6 * h.pinchAmt);
  const r = h.size * (0.46 + 0.12 * h.open) * (1 - 0.4 * h.charge);
  ctx.save();
  ctx.strokeStyle = `rgba(245,247,255,${a})`;
  ctx.fillStyle = `rgba(245,247,255,${a})`;
  ctx.lineWidth = 1.3;

  // main palm ring + ticks
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2 + t * 0.25;
    const r2 = r + (i % 6 === 0 ? 7 : 3.5);
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(ang) * r, y + Math.sin(ang) * r);
    ctx.lineTo(x + Math.cos(ang) * r2, y + Math.sin(ang) * r2);
    ctx.stroke();
  }
  // rotating outer arcs
  for (let i = 0; i < 3; i++) {
    const st = t * 0.7 + (i * Math.PI * 2) / 3;
    ctx.beginPath(); ctx.arc(x, y, r * 1.2, st, st + 1.1); ctx.stroke();
  }
  // dashed inner ring, counter-rotating
  ctx.save();
  ctx.translate(x, y); ctx.rotate(-t * 0.9);
  ctx.setLineDash([3, 6]);
  ctx.globalAlpha = 0.8;
  ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // tangled "atom" scribble in the palm
  ctx.lineWidth = 1;
  for (let j = 0; j < 4; j++) {
    ctx.beginPath();
    ctx.ellipse(x, y, r * (0.55 - j * 0.07), r * (0.16 + j * 0.05), t * (0.8 + j * 0.37) + j * 1.4, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  for (let i = 0; i <= 90; i++) {
    const u = (i / 90) * Math.PI * 2;
    const px = x + Math.sin(3 * u + t * 1.3) * r * 0.36;
    const py = y + Math.sin(4 * u + t * 0.9) * r * 0.3;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill();

  // wide open hand: extra faint outer ring
  if (h.open > 0.7 && h.pinchAmt < 0.3) {
    ctx.globalAlpha = (h.open - 0.7) / 0.3 * 0.35;
    ctx.beginPath(); ctx.arc(x, y, r * 1.75, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // fingertip markers + number tags
  const tr = Math.max(4.5, Math.min(9, h.size * 0.09));
  ctx.lineWidth = 1.2;
  ctx.font = "600 10px 'Instrument Sans', system-ui, sans-serif";
  ctx.textBaseline = "middle";
  h.tips.forEach((p, i) => {
    const idx = TIPS[i];
    ctx.beginPath(); ctx.arc(p.x, p.y, tr, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2); ctx.fill();
    if (!LABELLED.has(idx) || h.charge > 0.3 || h.pinchAmt > 0.3) return;
    let dx = p.x - x, dy = p.y - y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    const lx = p.x + dx * h.size * 0.42, ly = p.y + dy * h.size * 0.42;
    const value = idx === 4 ? h.pinch * 100 : h.bends[i - 1];
    const text = value.toFixed(1);
    const bw = ctx.measureText(text).width + 10, bh = 15;
    const bx = dx < 0 ? lx - bw : lx;
    ctx.save();
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(p.x + dx * tr, p.y + dy * tr); ctx.lineTo(dx < 0 ? bx + bw : bx, ly); ctx.stroke();
    ctx.restore();
    ctx.strokeRect(bx, ly - bh / 2, bw, bh);
    ctx.fillText(text, bx + 5, ly + 0.5);
  });
  ctx.restore();
}

function drawPinchHud(h) {
  if (!h.pinchPt || h.pinchAmt <= 0.02) return;
  const { x, y } = h.pinchPt, r = h.size * 0.42, a = h.pinchAmt * h.vis;
  ctx.save();
  ctx.strokeStyle = `rgba(245,247,255,${0.85 * a})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const st = -clock * 1.6 + (i * Math.PI * 2) / 3;
    ctx.beginPath(); ctx.arc(x, y, r * 1.3, st, st + 0.9); ctx.stroke();
  }
  ctx.setLineDash([2, 4]);
  ctx.beginPath(); ctx.arc(x, y, r * 0.6, clock * 2, clock * 2 + Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawShocks() {
  ctx.save();
  ctx.lineWidth = 1.4;
  for (const s of showHud ? shocks : []) {
    if (s.t < 0) continue;
    const k = s.t / s.dur, e = 1 - Math.pow(1 - k, 3);
    ctx.strokeStyle = `rgba(245,247,255,${(1 - k) * 0.85})`;
    ctx.beginPath(); ctx.arc(s.x, s.y, lerp(s.r0, s.r1, e), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  if (flash > 0) {
    ctx.fillStyle = `rgba(${palette.core},${flash})`;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground();
  drawSparks();
  if (showHud) for (const h of hands.values()) { drawHud(h); drawPinchHud(h); }
  drawShocks();
}

// ---------- Status ----------
let lastStatus = "";
function updateStatus() {
  let s;
  if (recorder) s = `Recording ${fmt(recSeconds)}`;
  else if (modelFailed) s = "Couldn't load hand tracking. Check your internet and reload.";
  else if (!cameraOn) s = landmarker ? "Ready" : "Loading hand tracking…";
  else {
    const seen = [...hands.values()].filter((h) => h.seen);
    const charging = seen.find((h) => h.charge > 0.05);
    if (!seen.length) s = "Hold your hand up";
    else if (charging) s = `Charging ${Math.round(charging.charge * 100)}%`;
    else if (link.strength > 0.5) s = "Exchanging sparks";
    else if (seen.some((h) => h.pinchAmt > 0.5)) s = "Sparks at your fingertips";
    else s = seen.length === 2 ? "Open both hands to exchange sparks" : "Open, move, or make a fist";
  }
  if (s !== lastStatus) { statusEl.textContent = s; lastStatus = s; }
}
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

// ---------- Loop ----------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (landmarker && cameraOn && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processHands(landmarker.detectForVideo(video, now), now);
  }
  update(dt);
  render();
  if (recorder) recSeconds = (now - recStart) / 1000;
  updateStatus();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Camera + model ----------
const modelReady = createHandLandmarker({ numHands: 2 })
  .then((l) => { landmarker = l; })
  .catch(() => { modelFailed = true; });

$("startBtn").onclick = async () => {
  const btn = $("startBtn");
  btn.disabled = true;
  btn.textContent = "Opening camera…";
  try {
    await startCamera(video);
    cameraOn = true;
    $("intro").classList.add("gone");
    await modelReady;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Try again";
    statusEl.textContent = "Camera blocked. Allow camera access in your browser, then try again.";
  }
};

// ---------- Recording ----------
let recorder = null, recChunks = [], recStart = 0, recSeconds = 0, recTimer = 0;
const recMime = (() => {
  if (!window.MediaRecorder || !canvas.captureStream) return null;
  return ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    .find((t) => MediaRecorder.isTypeSupported?.(t)) || null;
})();
if (!recMime) $("recBtn").hidden = true;
$("recBtn").onclick = toggleRecording;

function toggleRecording() {
  if (!recMime) return;
  if (recorder) { recorder.stop(); return; }
  const stream = canvas.captureStream(30);
  recorder = new MediaRecorder(stream, { mimeType: recMime, videoBitsPerSecond: 8_000_000 });
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  recorder.onstop = () => {
    clearTimeout(recTimer);
    const type = recMime.split(";")[0];
    const blob = new Blob(recChunks, { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `enchanted-${Date.now()}.${type.endsWith("mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    recorder = null;
    $("recBtn").classList.remove("on");
    $("recLabel").textContent = "Record";
    $("recBtn").title = "Record a clip (R)";
  };
  recorder.start(250);
  recStart = performance.now();
  recSeconds = 0;
  recTimer = setTimeout(() => recorder?.stop(), MAX_RECORD_S * 1000);
  $("recBtn").classList.add("on");
  $("recLabel").textContent = "Stop";
  $("recBtn").title = "Stop and save (R)";
}

// Lets automated tests drive the effect with synthetic hands (no camera needed)
window.__enchanted = { processHands, hands };

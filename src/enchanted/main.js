// Enchanted: magical sparks + a sci-fi HUD that follow your hands.
import {
  createHandLandmarker, startCamera, screenMapper, fingerStates, fingerBends, classifyPose,
  pinchRatio, PoseFilter, dist,
} from "../shared/hands.js";
import { glowSprite } from "../spells/fx.js";

// ---------- Tuning ----------
const MAX_SPARKS = 3600;
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
let landmarker = null, modelFailed = false, cameraOn = false, showCam = true, lastVideoTime = -1;
let palette = PALETTES.gold, paletteName = "gold";
const hands = new Map();          // key -> hand state
let sparks = [];                  // { x, y, vx, vy, life, max, w, heat }
let shocks = [];                  // expanding burst rings
let carriers = [];                // glowing heads flowing between two hands
const link = { strength: 0, a: null, b: null, spawnTop: 0, spawnBottom: 0 };
const LINK_RATE = 16;             // carriers per second on each arc
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
    const openNow = f.filter((s) => s === "ext").length / 4;
    h.open = lerp(h.open, openNow, 0.3);

    // ✊ charge -> ✋ release
    if (h.pose === "fist") {
      h.charge = Math.min(1, h.charge + 1 / 30 / CHARGE_TIME);
    } else if (h.charge > BURST_MIN && h.open > 0.5) {
      burst(h, h.charge);
      h.charge = 0;
    } else {
      h.charge = Math.max(0, h.charge - 0.02);
    }
  }
}

// ---------- Two hands: sparks flow back and forth ----------
// Top arc goes left hand -> right hand, bottom arc comes back (a loop, like the sketch)
function arcPoint(from, to, side, u) {
  const dx = to.palm.x - from.palm.x, dy = to.palm.y - from.palm.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  // normal that points up on screen for the top arc, down for the bottom arc
  let nx = -uy, ny = ux;
  if (ny > 0) { nx = -nx; ny = -ny; }
  nx *= side; ny *= side;
  const p0 = { x: from.palm.x + ux * from.size * 0.45, y: from.palm.y + uy * from.size * 0.45 };
  const p2 = { x: to.palm.x - ux * to.size * 0.45, y: to.palm.y - uy * to.size * 0.45 };
  const c = { x: (p0.x + p2.x) / 2 + nx * d * 0.38, y: (p0.y + p2.y) / 2 + ny * d * 0.38 };
  const v = 1 - u;
  return { x: v * v * p0.x + 2 * v * u * c.x + u * u * p2.x, y: v * v * p0.y + 2 * v * u * c.y + u * u * p2.y };
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
    link.spawnTop += dt * LINK_RATE * link.strength;
    link.spawnBottom += dt * LINK_RATE * link.strength;
    while (link.spawnTop >= 1) { link.spawnTop--; carriers.push(newCarrier(link.a, link.b, 1)); }
    while (link.spawnBottom >= 1) { link.spawnBottom--; carriers.push(newCarrier(link.b, link.a, -1)); }
  }

  for (const c of carriers) {
    if (!c.from.seen || !c.to.seen || !c.from.palm || !c.to.palm) {
      // a hand left: the carrier fizzles out where it is
      for (let i = 0; i < 6; i++) addSpark({ x: c.x, y: c.y, vx: rand(-80, 80), vy: rand(-80, 80), max: rand(0.3, 0.6), w: rand(1, 2), heat: 0.3 });
      c.dead = true;
      continue;
    }
    c.u += dt / c.dur;
    const wob = Math.sin(clock * 9 + c.seed) * c.from.size * 0.07;
    const p = arcPoint(c.from, c.to, c.side, Math.min(1, c.u));
    const px = c.x ?? p.x, py = c.y ?? p.y;
    c.x = p.x + wob * c.side * 0.5; c.y = p.y + wob;
    // trail: sparks left behind along the arc
    const n = 3;
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

function newCarrier(from, to, side) {
  return { from, to, side, u: 0, dur: rand(0.7, 1.0), seed: rand(0, 100), x: undefined, y: undefined };
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
    h.phase += dt * (3.4 + h.charge * 7 + Math.min(4, speed / 400));
    if (!h.seen) continue;

    // Two crossing orbits around the palm, like the video's swirls
    const R = h.size * (0.95 + 0.25 * h.open) * (1 - 0.7 * h.charge);
    for (let k = 0; k < 2; k++) {
      const a = h.phase + k * Math.PI;
      const tilt = h.angle + (k ? 0.95 : -0.95);
      const lx = Math.cos(a) * R, ly = Math.sin(a) * R * 0.42;
      const ex = h.palm.x + lx * Math.cos(tilt) - ly * Math.sin(tilt);
      const ey = h.palm.y + lx * Math.sin(tilt) + ly * Math.cos(tilt);
      const tx = -Math.sin(a) * R, ty = Math.cos(a) * R * 0.42;
      const tl = Math.hypot(tx, ty) || 1;
      const ux = (tx * Math.cos(tilt) - ty * Math.sin(tilt)) / tl;
      const uy = (tx * Math.sin(tilt) + ty * Math.cos(tilt)) / tl;
      const count = Math.round(7 + Math.min(12, speed / 110) + h.charge * 8);
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
  // flowing carriers between the hands
  for (const c of carriers) {
    if (c.x === undefined) continue;
    const g = (c.from.size * 0.38) * (0.8 + 0.4 * Math.sin(c.u * Math.PI));
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
    const R = h.size * (0.95 + 0.25 * h.open) * (1 - 0.7 * h.charge);
    for (let k = 0; k < 2; k++) {
      const a = h.phase + k * Math.PI, tilt = h.angle + (k ? 0.95 : -0.95);
      const lx = Math.cos(a) * R, ly = Math.sin(a) * R * 0.42;
      const x = h.palm.x + lx * Math.cos(tilt) - ly * Math.sin(tilt);
      const y = h.palm.y + lx * Math.sin(tilt) + ly * Math.cos(tilt);
      const g = h.size * 0.55;
      ctx.globalAlpha = 0.55 * h.vis;
      ctx.drawImage(glowSprite(palette.core), x - g / 2, y - g / 2, g, g);
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
  const a = 0.85 * h.vis;
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
  if (h.open > 0.7) {
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
    if (!LABELLED.has(idx) || h.charge > 0.3) return;
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

function drawLinkHud() {
  if (link.strength <= 0.02 || !link.a?.palm || !link.b?.palm) return;
  ctx.save();
  ctx.strokeStyle = `rgba(245,247,255,${0.3 * link.strength})`;
  ctx.lineWidth = 1.1;
  ctx.setLineDash([2, 7]);
  ctx.lineDashOffset = -clock * 30;
  for (const [from, to, side] of [[link.a, link.b, 1], [link.b, link.a, -1]]) {
    ctx.beginPath();
    for (let i = 0; i <= 30; i++) {
      const p = arcPoint(from, to, side, i / 30);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawShocks() {
  ctx.save();
  ctx.lineWidth = 1.4;
  for (const s of shocks) {
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
  drawLinkHud();
  for (const h of hands.values()) drawHud(h);
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

import {
  createHandLandmarker, startCamera, screenMapper, fingerStates, classifyPose,
  pinchRatio, PoseFilter, dist, isPointing,
} from "../shared/hands.js";
import { HandMouse } from "../shared/handmouse.js";
import { SPELLS, SPELL_IDS, recognize, drawGlyph, glyphSvg } from "./runes.js";
import { FX, glowSprite, rand } from "./fx.js";
import { sfx, unlockAudio, isMuted, setMuted } from "./audio.js";

// ---------- Tuning ----------
const LIFT_GRACE_MS = 300;     // pointing pose may glitch this long before the rune ends
const HAND_LOST_MS = 350;      // hand may vanish this long mid-rune without breaking it
const LIVES = 5;
const STARTER_SPELLS = ["protego", "incendio", "expelliarmus"];
const UNLOCK_AT = 20;          // seconds until lightning + ice join the fight
const COMBO_WINDOW = 3000;     // ms between banishes to keep a combo

// ---------- Setup ----------
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("fx");
const ctx = canvas.getContext("2d");
const fx = new FX(ctx);
const handMouse = new HandMouse();
const toScreen = screenMapper(video);

let W = 0, H = 0, S = 1, dpr = 1;
function resize() {
  dpr = Math.min(1.5, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  S = Math.min(W, H) / 800;
}
resize();
window.addEventListener("resize", resize);

// ---------- State ----------
let landmarker = null, cameraOn = false, lastVideoTime = -1;
let screen = "menu";                    // menu | play | practice | over
let wand = null, palm = null, handVisible = false;
let drawing = false, mouseDrawing = false, graceSince = 0, lostSince = 0, graceIdx = null, stroke = [];
let trails = [];
let lumos = false, openSince = 0, fistSince = 0;
const poseFilter = new PoseFilter(3);

let enemies = [], projectiles = [], timers = [];
let score = 0, lives = LIVES, combo = 0, maxCombo = 0, lastKill = 0, kills = 0;
let elapsed = 0, spawnT = 0, unlocked = false;
let best = 0;
try { best = +localStorage.getItem("vision.spells.best") || 0; } catch {}

// ---------- Rune dock ----------
const dock = $("dock");
for (const id of SPELL_IDS) {
  const sp = SPELLS[id];
  const el = document.createElement("div");
  el.className = "rune";
  el.dataset.id = id;
  el.style.setProperty("--c", sp.color);
  el.innerHTML = `${glyphSvg(id, 40)}<b>${sp.name}</b><small>${sp.desc}</small>`;
  dock.appendChild(el);
}
const runeEl = (id) => dock.querySelector(`[data-id="${id}"]`);
function setLocks() {
  for (const id of SPELL_IDS) {
    runeEl(id).classList.toggle("locked", screen === "play" && !unlocked && !STARTER_SPELLS.includes(id));
  }
}
function flashRune(id, cls = "cast") {
  const el = runeEl(id);
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// ---------- UI helpers ----------
function setScreen(s) {
  screen = s;
  document.body.classList.remove("mode-menu", "mode-play", "mode-practice", "mode-over");
  document.body.classList.add("mode-" + s);
  $("menu").classList.toggle("show", s === "menu");
  $("over").classList.toggle("show", s === "over");
  if (s !== "menu" && s !== "over") handMouse.hide();
  setLocks();
}
setScreen("menu");

function banner(text, color) {
  const b = $("banner");
  b.textContent = text;
  b.style.setProperty("--c", color);
  b.classList.remove("show");
  void b.offsetWidth;
  b.classList.add("show");
}

function updateHud() {
  $("score").textContent = score.toLocaleString();
  const c = $("combo");
  const mult = Math.min(5, combo);
  const txt = mult > 1 ? `Combo ×${mult}` : "";
  if (txt !== c.textContent) {
    c.textContent = txt;
    if (txt) { c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop"); }
  }
  const L = $("lives");
  if (L.children.length !== LIVES) L.innerHTML = "<i></i>".repeat(LIVES);
  [...L.children].forEach((el, i) => el.classList.toggle("gone", i >= lives));
}

function syncMute() { document.body.classList.toggle("muted", isMuted()); }
syncMute();
$("muteBtn").onclick = () => { setMuted(!isMuted()); syncMute(); };
$("exitBtn").onclick = () => toMenu();
$("playBtn").onclick = () => begin("play");
$("practiceBtn").onclick = () => begin("practice");
$("againBtn").onclick = () => begin("play");
$("menuBtn").onclick = () => toMenu();
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toMenu();
  if (e.key.toLowerCase() === "m") { setMuted(!isMuted()); syncMute(); }
});

// ---------- Camera / model ----------
const modelReady = createHandLandmarker()
  .then((l) => { landmarker = l; $("loading").textContent = "The wand is ready ✦"; })
  .catch(() => { $("loading").textContent = "Couldn't load hand tracking. Check your internet and reload. You can still draw runes with the mouse or touch."; });

async function ensureCamera() {
  if (cameraOn) return true;
  $("loading").textContent = "Opening your camera…";
  try {
    await startCamera(video);
    cameraOn = true;
    document.body.classList.add("cam");
    await modelReady;
    $("loading").textContent = "The wand is ready ✦";
    return true;
  } catch (err) {
    $("loading").textContent = "No camera — you can still draw runes with mouse or touch.";
    return false;
  }
}

async function begin(mode) {
  unlockAudio();
  sfx.click();
  await ensureCamera();
  resetGame();
  setScreen(mode);
  if (mode === "play") banner("Begin", "#f3d48a");
  else banner("Practice", "#f3d48a");
}

function toMenu() {
  if (screen === "menu") return;
  enemies.forEach((e) => fx.smoke(e.x, e.y, "25,15,40", 10, e.r * 1.4, 0.5, e.r * 0.5));
  enemies = [];
  projectiles = [];
  setScreen("menu");
}

function resetGame() {
  enemies = []; projectiles = []; timers = [];
  score = 0; lives = LIVES; combo = 0; maxCombo = 0; kills = 0; lastKill = 0;
  elapsed = 0; spawnT = 1.2; unlocked = false;
  $("lastCast").textContent = "";
  updateHud();
}

// ---------- Mouse / touch drawing (also handy for testing) ----------
canvas.addEventListener("pointerdown", (e) => {
  if (screen !== "play" && screen !== "practice") return;
  unlockAudio();
  mouseDrawing = true;
  wand = { x: e.clientX, y: e.clientY };
  stroke = [{ ...wand }];
  sfx.whoosh();
});
canvas.addEventListener("pointermove", (e) => {
  if (!mouseDrawing) return;
  wand = { x: e.clientX, y: e.clientY };
  const last = stroke[stroke.length - 1];
  if (dist(last, wand) > 3) stroke.push({ ...wand });
});
const mouseUp = () => {
  if (!mouseDrawing) return;
  mouseDrawing = false;
  finishStroke(stroke);
  stroke = [];
};
canvas.addEventListener("pointerup", mouseUp);
canvas.addEventListener("pointercancel", mouseUp);

// ---------- Hands ----------
function handleHands(res, now) {
  const lm = res?.landmarks?.[0];
  if (!lm) {
    handVisible = false;
    if (drawing) {
      // Tracking dropped for a moment: keep the rune alive briefly
      if (!lostSince) { lostSince = now; if (graceIdx === null) graceIdx = stroke.length; }
      if (now - lostSince < HAND_LOST_MS) return;
      endHandStroke(true);
    }
    if (!mouseDrawing) wand = null;
    palm = null;
    handMouse.hide();
    poseFilter.reset();
    openSince = fistSince = 0;
    return;
  }
  handVisible = true;
  lostSince = 0;
  const VW = video.videoWidth, VH = video.videoHeight;
  const f = fingerStates(lm, VW, VH, res.worldLandmarks?.[0]);
  const pose = classifyPose(f);
  const stable = poseFilter.update(pose);

  const tip = toScreen(lm[8]);
  if (!mouseDrawing) wand = wand ? { x: wand.x + (tip.x - wand.x) * 0.8, y: wand.y + (tip.y - wand.y) * 0.8 } : tip;
  const pp = [0, 5, 9, 13, 17].map((i) => toScreen(lm[i]));
  palm = { x: pp.reduce((a, p) => a + p.x, 0) / 5, y: pp.reduce((a, p) => a + p.y, 0) / 5 };

  // Menus: pinch-to-click hand cursor
  if (screen === "menu" || screen === "over") {
    if (drawing) endHandStroke(false);
    const th = toScreen(lm[4]);
    handMouse.update({ x: (th.x + tip.x) / 2, y: (th.y + tip.y) / 2 }, pinchRatio(lm, VW, VH));
    return;
  }
  handMouse.hide();
  if (mouseDrawing) return;

  // ☝️ draw a rune
  let paused = false;
  if (!drawing) {
    if (isPointing(f)) {
      drawing = true; graceSince = 0; graceIdx = null;
      stroke = [{ ...wand }];
      sfx.whoosh();
    }
  } else {
    const ok = f[0] !== "curl" && !f.slice(1).includes("ext");
    if (ok) { graceSince = 0; graceIdx = null; }
    else {
      if (!graceSince) { graceSince = now; graceIdx = stroke.length; }
      if (now - graceSince > LIFT_GRACE_MS) endHandStroke(true);
      else paused = true;
    }
  }
  if (drawing && !paused) {
    const last = stroke[stroke.length - 1];
    if (dist(last, wand) > 3) stroke.push({ ...wand });
  }

  // ✋ Lumos / ✊ Nox
  if (stable === "open" && !drawing) {
    if (!openSince) openSince = now;
    if (!lumos && now - openSince > 600) setLumos(true);
  } else openSince = 0;
  if (stable === "fist") {
    if (!fistSince) fistSince = now;
    if (lumos && now - fistSince > 400) setLumos(false);
  } else fistSince = 0;
}

function endHandStroke(cast) {
  drawing = false;
  graceSince = 0;
  lostSince = 0;
  const pts = graceIdx !== null ? stroke.slice(0, graceIdx) : stroke;
  graceIdx = null;
  stroke = [];
  if (cast) finishStroke(pts);
}

function pathLen(p) { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; }
function centroid(p) { return { x: p.reduce((a, q) => a + q.x, 0) / p.length, y: p.reduce((a, q) => a + q.y, 0) / p.length }; }

function finishStroke(pts) {
  if (pts.length < 6 || pathLen(pts) < 60 * S) return; // too small: ignore
  // Aim assist: in battle, favour runes that are actually on a wraith right now
  const prefer = screen === "play" ? [...new Set(enemies.filter((e) => !e.dead && e.runes.length).map((e) => e.runes[0]))] : [];
  const r = recognize(pts, { prefer });
  if (r) {
    trails.push({ pts, rgb: SPELLS[r.id].glow, t: 0 });
    cast(r.id, pts, r.score);
  } else {
    trails.push({ pts, rgb: "140,140,160", t: 0 });
    fizzle(pts);
  }
}

function setLumos(on) {
  lumos = on;
  document.body.classList.toggle("lumos", on);
  banner(on ? "Lumos" : "Nox", on ? "#fff3cf" : "#8a8fb8");
  if (palm) fx.burst(palm.x, palm.y, on ? "255,240,200" : "120,120,170", on ? 60 : 25, on ? 8 : 4, 12);
  if (on) sfx.cast("protego"); else sfx.fizzle();
}

// ---------- Spells ----------
function later(sec, fn) { timers.push({ t: sec, fn }); }

function cast(id, pts, accuracy) {
  const sp = SPELLS[id];
  const o = pts[pts.length - 1];
  const c = centroid(pts);
  banner(sp.name, sp.color);
  sfx.cast(id);
  flashRune(id);
  fx.burst(o.x, o.y, sp.glow, 30, 6, 10);

  let targets = [];
  if (screen === "play") {
    targets = enemies.filter((e) => !e.dead && e.runes[0] === id);
    targets.forEach((e) => e.runes.shift());         // claim the rune now so it can't be hit twice
    if (!targets.length) { combo = 0; updateHud(); }
  }
  if (screen === "practice") {
    $("lastCast").textContent = `${sp.name} — ${Math.round(accuracy * 100)}% precise`;
  }
  EFFECTS[id](o, c, pts, targets);
}

function fizzle(pts) {
  const o = pts[pts.length - 1];
  fx.smoke(o.x, o.y, "90,90,110", 12, 40 * S, 0.45, 12);
  fx.sparkle(o.x, o.y, "180,180,200", 10, 3, 6);
  sfx.fizzle();
  if (screen === "practice") $("lastCast").textContent = "The rune fizzled… try a cleaner shape";
  if (screen === "play") { combo = 0; updateHud(); }
}

const EFFECTS = {
  incendio(o, c, pts, targets) {
    if (targets.length) targets.forEach((e, i) => shoot("fire", o, e, i * 0.08));
    else shoot("fire", o, { x: c.x + rand(-40, 40) * S, y: Math.max(80, c.y - 260 * S) }, 0);
  },
  fulgur(o, c, pts, targets) {
    const strike = (x, y, e) => {
      fx.lightning(x + rand(-140, 140) * S, -10, x, y);
      fx.burst(x, y, "138,216,255", 50, 11, 10);
      fx.ring(x, y, "138,216,255", 110 * S, 0.4, 5);
      if (e) hit(e);
    };
    if (targets.length) targets.forEach((e, i) => later(i * 0.12, () => strike(e.x, e.y, e)));
    else strike(c.x, c.y + 40 * S);
  },
  glacius(o, c, pts, targets) {
    if (targets.length) targets.forEach((e, i) => shoot("ice", o, e, i * 0.06));
    else {
      fx.shards(o.x, o.y, 34, 15);
      fx.ring(o.x, o.y, "159,252,255", 170 * S, 0.5, 5);
      fx.burst(o.x, o.y, "159,252,255", 40, 8, 10);
    }
  },
  expelliarmus(o, c, pts, targets) {
    const w = 10 * S + 4;
    if (targets.length) {
      targets.forEach((e, i) => later(i * 0.08, () => {
        fx.beam(o.x, o.y, e.x, e.y, "255,77,109", 0.45, w);
        fx.burst(e.x, e.y, "255,77,109", 50, 12, 10);
        hit(e);
      }));
    } else {
      const a = pts[0], b = pts[pts.length - 1];
      const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
      fx.beam(o.x, o.y, o.x + (dx / L) * 2400, o.y + (dy / L) * 2400, "255,77,109", 0.45, w);
    }
  },
  protego(o, c, pts, targets) {
    const r = Math.max(110 * S, pts.reduce((a, p) => a + dist(p, c), 0) / pts.length);
    fx.shield(c.x, c.y, r, 1.8);
    fx.ring(c.x, c.y, "255,209,102", r * 1.5, 0.7, 5);
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      fx.sparkle(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, "255,220,140", 1, 1.5, 9);
    }
    if (targets.length) {
      fx.ring(c.x, c.y, "255,209,102", Math.hypot(W, H), 0.9, 6);
      targets.forEach((e) => later(Math.min(0.7, dist(c, e) / 1600), () => {
        fx.ring(e.x, e.y, "255,209,102", 90 * S, 0.45, 4);
        fx.burst(e.x, e.y, "255,209,102", 45, 9, 10);
        hit(e);
      }));
    }
  },
};

function shoot(type, from, target, delay) {
  const d = dist(from, target);
  projectiles.push({
    type, target, x: from.x, y: from.y, sx: from.x, sy: from.y,
    t: -delay, dur: Math.max(0.25, Math.min(0.6, d / 1400)), side: Math.random() < 0.5 ? -1 : 1,
  });
  if (delay === 0) sfx.whoosh();
}

function impact(p) {
  const { x, y } = p.target;
  if (p.type === "fire") fx.explosion(x, y, 0.6 + S * 0.4);
  else {
    fx.shards(x, y, 26, 12);
    fx.ring(x, y, "159,252,255", 120 * S, 0.5, 5);
    fx.burst(x, y, "200,250,255", 50, 9, 10);
    fx.flash("160,240,255", 0.15);
  }
  if (p.target.runes) hit(p.target);
}

// ---------- Enemies ----------
function spellPool() { return unlocked ? SPELL_IDS : STARTER_SPELLS; }

function spawn() {
  const pool = spellPool();
  const n = elapsed < 25 ? 1 : elapsed < 60 ? (Math.random() < 0.55 ? 1 : 2) : 1 + Math.floor(Math.random() * 3);
  const runes = Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]);
  const r = 30 * S + 12;
  const x = rand(0.14, 0.86) * W;
  enemies.push({
    x, baseX: x, y: -r * 2, r, runes, total: n,
    speed: Math.min(125, 36 + elapsed * 1.05) * S, seed: rand(0, 10), t: 0, flash: 0, dead: false,
  });
}

function hit(e) {
  if (e.dead) return;
  sfx.hit();
  e.flash = 1;
  if (e.runes.length === 0) kill(e);
  else {
    e.y -= 40 * S;
    fx.burst(e.x, e.y, "255,255,255", 20, 6, 8);
  }
}

function kill(e) {
  e.dead = true;
  kills++;
  const now = performance.now();
  combo = now - lastKill < COMBO_WINDOW ? combo + 1 : 1;
  lastKill = now;
  maxCombo = Math.max(maxCombo, combo);
  const mult = Math.min(5, combo);
  const pts = 100 * e.total * mult;
  score += pts;
  fx.text(e.x, e.y - e.r, `+${pts}`, "#ffe9a8", 22 * S + 12);
  fx.smoke(e.x, e.y, "20,10,30", 22, e.r * 1.8, 0.7, e.r * 0.6);
  for (let i = 0; i < 26; i++) {
    fx.add({ type: "glow", rgb: "200,170,255", x: e.x + rand(-e.r, e.r) * 0.6, y: e.y, vx: rand(-1, 1), vy: -rand(1.5, 4), size: rand(4, 10), max: rand(0.8, 1.4), drag: 0.97, g: -0.02 });
  }
  updateHud();
}

function loseLife(e) {
  lives--;
  fx.smoke(e.x, e.y, "40,10,30", 26, e.r * 2, 0.75, e.r);
  fx.flash("255,30,60", 0.35);
  fx.shake = Math.max(fx.shake, 20);
  sfx.hurt();
  combo = 0;
  updateHud();
  if (lives <= 0) gameOver();
}

function gameOver() {
  enemies.forEach((e) => fx.smoke(e.x, e.y, "25,15,40", 12, e.r * 1.4, 0.6, e.r * 0.5));
  enemies = [];
  projectiles = [];
  const newBest = score > best;
  if (newBest) { best = score; try { localStorage.setItem("vision.spells.best", String(best)); } catch {} }
  $("overTitle").textContent = newBest && score > 0 ? "A new legend is born" : "The wraiths prevailed";
  $("finalScore").textContent = score.toLocaleString();
  $("stKills").textContent = kills;
  $("stCombo").textContent = "×" + Math.min(5, maxCombo || 0);
  $("stBest").textContent = best.toLocaleString();
  setScreen("over");
}

// ---------- Update ----------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (landmarker && cameraOn && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    handleHands(landmarker.detectForVideo(video, now), now);
  }
  update(dt, now);
  render(now);
  requestAnimationFrame(frame);
}

function update(dt, now) {
  fx.update(dt);
  trails.forEach((t) => (t.t += dt));
  trails = trails.filter((t) => t.t < 0.9);

  for (const tm of timers) tm.t -= dt;
  const due = timers.filter((tm) => tm.t <= 0);
  timers = timers.filter((tm) => tm.t > 0);
  due.forEach((tm) => tm.fn());

  // projectiles
  for (const p of projectiles) {
    p.t += dt;
    if (p.t < 0) continue;
    const f = Math.min(1, p.t / p.dur);
    const tx = p.target.x, ty = p.target.y;
    const nx = -(ty - p.sy), ny = tx - p.sx, nl = Math.hypot(nx, ny) || 1;
    const arc = Math.sin(Math.PI * f) * 50 * S * p.side;
    const e = f * f * (3 - 2 * f) * 0.4 + f * 0.6;
    p.x = p.sx + (tx - p.sx) * e + (nx / nl) * arc;
    p.y = p.sy + (ty - p.sy) * e + (ny / nl) * arc;
    if (p.type === "fire") fx.fire(p.x, p.y, 5, 5 * S, 1.2, 24 * S + 6);
    else {
      fx.sparkle(p.x, p.y, "159,252,255", 3, 1.2, 9);
      if (Math.random() < 0.4) fx.add({ type: "shard", rgb: "180,250,255", x: p.x, y: p.y, vx: rand(-1, 1), vy: rand(-1, 1), size: rand(5, 10), max: 0.4, rot: rand(0, 6), vr: 0.2 });
    }
    if (f >= 1) { p.done = true; impact(p); }
  }
  projectiles = projectiles.filter((p) => !p.done);

  // game
  if (screen === "play") {
    elapsed += dt;
    if (!unlocked && elapsed >= UNLOCK_AT) {
      unlocked = true;
      setLocks();
      banner("New runes awaken", "#8ad8ff");
      flashRune("fulgur", "unlock");
      flashRune("glacius", "unlock");
    }
    spawnT -= dt;
    if (spawnT <= 0) {
      spawn();
      spawnT = Math.max(0.95, 2.9 - elapsed * 0.025);
    }
    for (const e of enemies) {
      e.t += dt;
      const doomed = e.runes.length === 0;
      e.y += e.speed * dt * (doomed ? 0.25 : 1);
      e.x = e.baseX + Math.sin(e.t * 0.9 + e.seed) * 40 * S;
      e.flash = Math.max(0, e.flash - dt * 3);
      if (Math.random() < 0.6) {
        fx.smoke(e.x + rand(-e.r, e.r) * 0.5, e.y + rand(-0.2, 0.8) * e.r, "22,12,38", 1, e.r * 1.1, 0.32, 2);
      }
      if (!e.dead && e.y > H - 30 * S) {
        e.dead = true;
        if (doomed) kill(e);
        else loseLife(e);
        if (screen !== "play") break;
      }
    }
    enemies = enemies.filter((e) => !e.dead);
    if (combo && now - lastKill > COMBO_WINDOW) { combo = 0; updateHud(); }
  }

  // ambient embers
  if (Math.random() < 0.25) {
    fx.add({ type: "glow", rgb: "255,210,150", x: rand(0, W), y: H + 10, vx: rand(-0.3, 0.3), vy: -rand(0.3, 0.9), size: rand(2, 5), max: rand(5, 9), drag: 1 });
  }
  // wand + lumos sparkles
  if (wand && (handVisible || mouseDrawing) && (screen === "play" || screen === "practice")) {
    const live = drawing || mouseDrawing;
    fx.sparkle(wand.x, wand.y, live ? "255,214,140" : "255,235,190", live ? 3 : 1, live ? 2 : 0.7, live ? 10 : 6);
  }
  if (lumos && palm) fx.sparkle(palm.x + rand(-20, 20), palm.y + rand(-20, 20), "225,240,255", 2, 1.2, 9);
}

// ---------- Render ----------
function strokePath(pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
}

function drawRuneTrail(pts, rgb, a) {
  if (pts.length < 2) return;
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [w, al, col] of [[22, 0.1, rgb], [10, 0.35, rgb], [3, 1, "255,255,255"]]) {
    ctx.strokeStyle = `rgba(${col},${al * a})`;
    ctx.lineWidth = w * (0.7 + S * 0.3);
    strokePath(pts);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawEnemy(e, now) {
  const { x, y, r } = e;
  // shadow aura
  let g = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
  g.addColorStop(0, "rgba(6,3,14,0.95)");
  g.addColorStop(0.45, "rgba(18,8,36,0.65)");
  g.addColorStop(1, "rgba(18,8,36,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 2, 0, Math.PI * 2);
  ctx.fill();

  // hooded cloak with tattered hem
  ctx.fillStyle = "rgba(4,2,10,0.94)";
  ctx.beginPath();
  ctx.moveTo(x - r * 0.85, y + r * 0.6);
  ctx.quadraticCurveTo(x - r * 1.05, y - r * 1.1, x, y - r * 1.2);
  ctx.quadraticCurveTo(x + r * 1.05, y - r * 1.1, x + r * 0.85, y + r * 0.6);
  const teeth = 6;
  for (let i = teeth; i >= 0; i--) {
    const fx_ = x - r * 0.85 + (i / teeth) * r * 1.7;
    const wave = Math.sin(e.t * 5 + i * 1.7 + e.seed) * r * 0.18;
    ctx.lineTo(fx_, y + r * (i % 2 ? 1.25 : 0.75) + wave);
  }
  ctx.closePath();
  ctx.fill();

  // hollow face
  g = ctx.createRadialGradient(x, y - r * 0.25, 0, x, y - r * 0.25, r * 0.6);
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(x, y - r * 0.25, r * 0.55, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // glowing eyes
  ctx.globalCompositeOperation = "lighter";
  const blink = Math.sin(e.t * 2.3 + e.seed * 7) > 0.96 ? 0.15 : 1;
  const eyeS = r * 0.75 * blink;
  for (const side of [-1, 1]) {
    const ex = x + side * r * 0.22, ey = y - r * 0.3;
    ctx.drawImage(glowSprite("255,50,120"), ex - eyeS / 2, ey - eyeS / 4, eyeS, eyeS / 2);
  }
  if (e.flash > 0) {
    const s = r * 4 * e.flash;
    ctx.globalAlpha = e.flash;
    ctx.drawImage(glowSprite("255,255,255"), x - s / 2, y - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = "source-over";

  // runes to banish it
  if (!e.runes.length) return;
  const gs = r * 0.5;
  const gap = gs * 2.9;
  const gy = y - r * 2.05;
  const startX = x - ((e.runes.length - 1) * gap) / 2;
  e.runes.forEach((id, i) => {
    const gx = startX + i * gap;
    ctx.fillStyle = i === 0 ? "rgba(8,5,16,0.7)" : "rgba(8,5,16,0.45)";
    ctx.strokeStyle = i === 0 ? `rgba(${SPELLS[id].glow},0.55)` : "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(gx, gy, gs * 1.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const pulse = i === 0 ? 0.85 + 0.15 * Math.sin(now / 180) : 0.35;
    drawGlyph(ctx, id, gx, gy, gs, pulse, 2 * S + 1);
  });
}

function render(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const sh = fx.shakeOffset();
  ctx.translate(sh.x, sh.y);
  video.style.setProperty("--sx", `${-sh.x}px`);
  video.style.setProperty("--sy", `${sh.y}px`);

  for (const e of enemies) drawEnemy(e, now);

  for (const t of trails) drawRuneTrail(t.pts, t.rgb, 1 - t.t / 0.9);
  if ((drawing || mouseDrawing) && stroke.length > 1) drawRuneTrail(stroke, "255,200,110", 1);

  // projectile cores
  ctx.globalCompositeOperation = "lighter";
  for (const p of projectiles) {
    if (p.t < 0) continue;
    const s = (p.type === "fire" ? 60 : 44) * S + 16;
    ctx.drawImage(glowSprite(p.type === "fire" ? "255,190,110" : "170,250,255"), p.x - s / 2, p.y - s / 2, s, s);
  }

  // wand tip
  if (wand && (handVisible || mouseDrawing) && (screen === "play" || screen === "practice")) {
    const s = (26 + Math.sin(now / 120) * 4) * (0.7 + S * 0.3);
    ctx.drawImage(glowSprite("255,225,160"), wand.x - s / 2, wand.y - s / 2, s, s);
  }
  // lumos orb
  if (lumos && palm) {
    const pulse = 1 + Math.sin(now / 250) * 0.08;
    const big = 220 * S * pulse + 60, small = 60 * S + 20;
    ctx.globalAlpha = 0.55;
    ctx.drawImage(glowSprite("200,225,255"), palm.x - big / 2, palm.y - big / 2, big, big);
    ctx.globalAlpha = 1;
    ctx.drawImage(glowSprite("255,255,255"), palm.x - small / 2, palm.y - small / 2, small, small);
  }
  ctx.globalCompositeOperation = "source-over";

  fx.draw();
}

updateHud();
requestAnimationFrame(frame);

// Finger Ninja: your index fingertip is the blade.
import { createHandLandmarker, startCamera, screenMapper } from "../shared/hands.js";
import { glowSprite } from "../spells/fx.js";
import { sfx, unlockAudio } from "../spells/audio.js";

// ---------- Tuning ----------
const CUT_SPEED = 900;        // px/s the blade must move to cut (scaled to screen size)
const TRAIL_MS = 140;         // how long the blade trail lasts
const LIVES = 3;
const COMBO_MS = 260;         // fruits cut within this window count as one combo
const FRUITS = [
  ["🍉", "120,210,90"], ["🍊", "255,160,40"], ["🍎", "235,60,60"], ["🍋", "250,225,70"],
  ["🥝", "150,200,70"], ["🍑", "255,160,120"], ["🍇", "160,90,210"], ["🍍", "245,205,70"],
];
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

// ---------- Setup ----------
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("game");
const ctx = canvas.getContext("2d");
const toScreen = screenMapper(video);

let W = 0, H = 0, S = 1, dpr = 1;
function resize() {
  dpr = Math.min(1.5, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  S = Math.min(W, H) / 800;
}
resize();
window.addEventListener("resize", resize);

// ---------- State ----------
let landmarker = null, modelFailed = false, cameraOn = false, lastVideoTime = -1;
let mode = "intro";          // intro | menu | play | over
let items = [], halves = [], drops = [], texts = [];
let trail = [];              // blade points { x, y, t }
let score = 0, lives = LIVES, elapsed = 0, spawnT = 0, shake = 0, flash = 0;
let comboCount = 0, comboT = 0, comboPos = null, overT = 0;
let best = 0;
try { best = +localStorage.getItem("handheld.ninja.best") || 0; } catch {}
let starter = null;          // the watermelon you slice to start / restart

const rand = (a, b) => a + Math.random() * (b - a);

// ---------- HUD ----------
function renderHud() {
  $("score").textContent = score;
  $("best").textContent = `Best ${best}`;
  const L = $("lives");
  if (L.children.length !== LIVES) L.innerHTML = "<i>✕</i>".repeat(LIVES);
  [...L.children].forEach((el, i) => el.classList.toggle("lost", i < LIVES - lives));
}
renderHud();

// ---------- Blade input ----------
function addBladePoint(x, y, now) {
  trail.push({ x, y, t: now });
}
canvas.addEventListener("pointerdown", (e) => { unlockAudio(); addBladePoint(e.clientX, e.clientY, performance.now()); });
canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse" && !(e.buttons & 1)) return;
  addBladePoint(e.clientX, e.clientY, performance.now());
});

function processHands(res, now) {
  const lm = res?.landmarks?.[0];
  if (!lm) return;
  const p = toScreen(lm[8]);
  addBladePoint(p.x, p.y, now);
}

// ---------- Game flow ----------
function makeStarter() {
  starter = { emoji: "🍉", rgb: "120,210,90", x: W / 2, y: H * 0.56, r: 70 * S + 26, rot: 0, vx: 0, vy: 0, vr: 0.4, bob: 0, starter: true };
}
function toMenu() { mode = "menu"; items = []; makeStarter(); }
function startGame() {
  mode = "play"; score = 0; lives = LIVES; elapsed = 0; spawnT = 0.6; items = []; starter = null;
  renderHud();
  text(W / 2, H * 0.35, "Go!", "#f5f7ff", 64);
}
function gameOver(reason) {
  if (mode !== "play") return;
  mode = "over"; overT = 0;
  if (score > best) { best = score; try { localStorage.setItem("handheld.ninja.best", String(best)); } catch {} }
  renderHud();
  setTimeout(() => { if (mode === "over") makeStarter(); }, 900);
  if (reason === "bomb") sfx.hurt();
}

function launch(bomb = false) {
  const r = (bomb ? 40 : rand(38, 52)) * S + 14;
  const x = rand(0.15, 0.85) * W;
  const peak = rand(0.12, 0.42) * H;              // how high it flies
  const g = 1500 * S;
  const vy = -Math.sqrt(2 * g * (H + r - peak));
  const vx = ((W / 2 - x) / W) * rand(150, 420) * S;
  const [emoji, rgb] = bomb ? ["💣", "90,90,100"] : FRUITS[Math.floor(Math.random() * FRUITS.length)];
  items.push({ emoji, rgb, bomb, x, y: H + r, vx, vy, r, rot: rand(0, 6), vr: rand(-3, 3), g });
}

// ---------- Cutting ----------
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function checkCuts(now) {
  if (trail.length < 2) return;
  const a = trail[trail.length - 2], b = trail[trail.length - 1];
  const dt = Math.max(1, b.t - a.t) / 1000;
  const speed = Math.hypot(b.x - a.x, b.y - a.y) / dt;
  if (speed < CUT_SPEED * S) return;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const targets = starter ? [starter] : items;
  for (const it of targets) {
    if (it.cut || distToSeg(it, a, b) > it.r * 0.9) continue;
    it.cut = true;
    if (it.bomb) { explode(it); continue; }
    slice(it, angle, now);
  }
}

function slice(it, angle, now) {
  sfx.hit();
  const push = 140 * S;
  for (const side of [1, -1]) {
    halves.push({
      emoji: it.emoji, x: it.x, y: it.y, r: it.r, rot: it.rot, cut: angle, side, life: 0,
      vx: it.vx * 0.5 + Math.cos(angle + (side * Math.PI) / 2) * push, vy: Math.min(it.vy * 0.3, 0) + Math.sin(angle + (side * Math.PI) / 2) * push - 80 * S,
      vr: side * rand(2, 5), g: 1500 * S,
    });
  }
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2), v = rand(80, 520) * S;
    drops.push({ x: it.x, y: it.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 100 * S, life: 0, max: rand(0.4, 0.9), size: rand(3, 8) * S + 1, rgb: it.rgb });
  }
  if (it.starter) {
    starter = null;
    setTimeout(startGame, 350);
    return;
  }
  score += 1;
  if (now - comboT < COMBO_MS) comboCount++; else comboCount = 1;
  comboT = now; comboPos = { x: it.x, y: it.y };
  renderHud();
}

function explode(it) {
  flash = 0.7; shake = 26;
  for (let i = 0; i < 70; i++) {
    const a = rand(0, Math.PI * 2), v = rand(150, 900) * S;
    drops.push({ x: it.x, y: it.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0, max: rand(0.5, 1.2), size: rand(3, 10) * S + 1, rgb: Math.random() < 0.5 ? "255,170,60" : "255,240,200" });
  }
  it.dead = true;
  gameOver("bomb");
}

function text(x, y, str, color = "#f5f7ff", size = 34) {
  texts.push({ x, y, str, color, size: size * (0.6 + S * 0.4), t: 0 });
}

// ---------- Update ----------
function update(dt, now) {
  trail = trail.filter((p) => now - p.t < TRAIL_MS);
  checkCuts(now);

  // combo payout once the swipe is over
  if (comboCount && now - comboT > COMBO_MS) {
    if (comboCount >= 3) {
      score += comboCount;
      text(comboPos.x, comboPos.y - 40 * S, `${comboCount} fruit combo +${comboCount}`, "#a98bff", 34);
      renderHud();
    }
    comboCount = 0;
  }

  if (starter) { starter.bob += dt; starter.rot += starter.vr * dt; starter.y = H * 0.56 + Math.sin(starter.bob * 2) * 10 * S; starter.x = W / 2; }

  if (mode === "play") {
    elapsed += dt;
    spawnT -= dt;
    if (spawnT <= 0) {
      const n = 1 + Math.floor(Math.random() * Math.min(5, 1 + elapsed / 15));
      for (let i = 0; i < n; i++) setTimeout(() => mode === "play" && launch(), i * 140);
      if (elapsed > 8 && Math.random() < Math.min(0.45, 0.15 + elapsed / 120)) setTimeout(() => mode === "play" && launch(true), n * 140);
      spawnT = Math.max(0.9, 2.2 - elapsed / 40);
    }
  }
  for (const it of items) {
    it.vy += it.g * dt; it.x += it.vx * dt; it.y += it.vy * dt; it.rot += it.vr * dt;
    if (!it.cut && it.vy > 0 && it.y - it.r > H) {
      it.dead = true;
      if (!it.bomb && mode === "play") {
        lives--; renderHud(); sfx.fizzle();
        text(Math.max(40, Math.min(W - 40, it.x)), H - 50 * S, "✕", "#ff4d5e", 44);
        if (lives <= 0) gameOver("missed");
      }
    }
    if (it.cut && !it.bomb) it.dead = true;
  }
  items = items.filter((it) => !it.dead);
  for (const h of halves) { h.life += dt; h.vy += h.g * dt; h.x += h.vx * dt; h.y += h.vy * dt; h.rot += h.vr * dt; }
  halves = halves.filter((h) => h.y - h.r < H + 40);
  for (const d of drops) { d.life += dt / d.max; d.vx *= 0.985; d.vy += 900 * S * dt; d.x += d.vx * dt; d.y += d.vy * dt; }
  drops = drops.filter((d) => d.life < 1);
  for (const t of texts) t.t += dt;
  texts = texts.filter((t) => t.t < 1.1);
  shake *= Math.pow(0.85, dt * 60); if (shake < 0.3) shake = 0;
  flash = Math.max(0, flash - dt * 1.6);
  if (mode === "over") overT += dt;
}

// ---------- Render ----------
function drawBackground() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  if (cameraOn && video.readyState >= 2) {
    const VW = video.videoWidth, VH = video.videoHeight, s = Math.max(W / VW, H / VH);
    ctx.save();
    ctx.translate(W, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, (W - VW * s) / 2, (H - VH * s) / 2, VW * s, VH * s);
    ctx.restore();
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.strokeStyle = "rgba(245,247,255,0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < W; x += 48) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 0; y < H; y += 48) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
  }
}

function drawEmoji(e, x, y, r, rot) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.font = `${r * 2}px ${EMOJI_FONT}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(e, 0, r * 0.08);
  ctx.restore();
}

function drawHalf(h) {
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.rotate(h.cut + h.life * h.vr);           // the cut line spins as the half flies
  ctx.beginPath();
  ctx.rect(-h.r * 1.6, h.side > 0 ? 0 : -h.r * 1.6, h.r * 3.2, h.r * 1.6);
  ctx.clip();
  ctx.rotate(h.rot - h.cut);                   // fruit keeps the angle it had when cut
  ctx.font = `${h.r * 2}px ${EMOJI_FONT}`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(h.emoji, 0, h.r * 0.08);
  ctx.restore();
}

function drawBlade(now) {
  if (trail.length < 2) return;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.globalCompositeOperation = "lighter";
  for (let i = 1; i < trail.length; i++) {
    const a = trail[i - 1], b = trail[i];
    const k = 1 - (now - b.t) / TRAIL_MS;
    if (k <= 0) continue;
    ctx.strokeStyle = `rgba(169,139,255,${0.35 * k})`;
    ctx.lineWidth = 18 * k * (0.6 + S * 0.4);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.95 * k})`;
    ctx.lineWidth = 5 * k * (0.6 + S * 0.4);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const tip = trail[trail.length - 1], g = 46 * (0.6 + S * 0.4);
  ctx.drawImage(glowSprite("200,180,255"), tip.x - g / 2, tip.y - g / 2, g, g);
  ctx.restore();
}

function centerText(lines) {
  ctx.save();
  ctx.textAlign = "center";
  for (const [str, y, size, color, weight] of lines) {
    ctx.font = `${weight || 900} ${size}px "Schibsted Grotesk", system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 14;
    ctx.fillText(str, W / 2, y);
  }
  ctx.restore();
}

function render(now) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = shake ? rand(-shake, shake) : 0, sy = shake ? rand(-shake, shake) : 0;
  drawBackground();
  ctx.translate(sx, sy);

  for (const d of drops) {
    ctx.globalAlpha = 1 - d.life;
    ctx.fillStyle = `rgb(${d.rgb})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, d.size * (1 - d.life * 0.5), 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const h of halves) drawHalf(h);
  for (const it of items) {
    if (it.bomb) {
      const g = it.r * 3 * (1 + Math.sin(now / 80) * 0.1);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.35;
      ctx.drawImage(glowSprite("255,60,60"), it.x - g / 2, it.y - g / 2, g, g);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    drawEmoji(it.emoji, it.x, it.y, it.r, it.rot);
  }
  if (starter) {
    const g = starter.r * 3.2;
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.25;
    ctx.drawImage(glowSprite("169,139,255"), starter.x - g / 2, starter.y - g / 2, g, g);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    drawEmoji(starter.emoji, starter.x, starter.y, starter.r, starter.rot);
  }

  if (mode === "menu") {
    centerText([["Slice the watermelon to start", H * 0.3, 30 * (0.6 + S * 0.4), "#f5f7ff", 800]]);
  } else if (mode === "over") {
    centerText([
      ["Game over", H * 0.2, 64 * (0.6 + S * 0.4), "#f5f7ff"],
      [`${score} sliced${score >= best && score > 0 ? " · new best" : ""}`, H * 0.2 + 46 * (0.6 + S * 0.4), 24 * (0.6 + S * 0.4), "#a98bff", 700],
      ...(starter ? [["Slice the watermelon to play again", H * 0.36, 22 * (0.6 + S * 0.4), "#a4a7b8", 600]] : []),
    ]);
  }

  for (const t of texts) {
    ctx.save();
    ctx.globalAlpha = 1 - (t.t / 1.1) ** 2;
    ctx.font = `900 ${t.size}px "Schibsted Grotesk", system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.fillStyle = t.color;
    ctx.shadowColor = "rgba(0,0,0,0.7)"; ctx.shadowBlur = 10;
    ctx.fillText(t.str, t.x, t.y - t.t * 50);
    ctx.restore();
  }
  drawBlade(now);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (flash > 0) { ctx.fillStyle = `rgba(255,240,220,${flash})`; ctx.fillRect(0, 0, W, H); }
}

// ---------- Status ----------
let lastStatus = "";
function updateStatus() {
  let s;
  if (modelFailed) s = cameraOn ? "Hand tracking didn't load. Swipe on the screen instead." : "Couldn't load hand tracking. Check your internet and reload.";
  else if (!cameraOn) s = landmarker ? "Ready" : "Loading hand tracking…";
  else s = trail.length ? "☝️ Blade ready" : "Hold up your index finger";
  if (s !== lastStatus) { $("status").textContent = s; lastStatus = s; }
}

// ---------- Loop ----------
let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  if (landmarker && cameraOn && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    processHands(landmarker.detectForVideo(video, now), now);
  }
  update(dt, now);
  render(now);
  updateStatus();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- Start ----------
const modelReady = createHandLandmarker().then((l) => (landmarker = l)).catch(() => { modelFailed = true; });

$("startBtn").onclick = async () => {
  unlockAudio();
  const btn = $("startBtn");
  btn.disabled = true; btn.textContent = "Opening camera…";
  try {
    await startCamera(video);
    cameraOn = true;
  } catch {
    // no camera: still playable with mouse / touch
  }
  $("intro").classList.add("gone");
  toMenu();
  await modelReady;
};

// Lets automated tests drive the blade without a camera
window.__ninja = {
  blade: addBladePoint,
  state: () => ({ mode, score, lives, items: items.map((i) => ({ x: i.x, y: i.y, r: i.r, bomb: i.bomb })), starter: starter && { x: starter.x, y: starter.y } }),
  start: () => { $("intro").classList.add("gone"); toMenu(); },
};

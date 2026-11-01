import { createHandLandmarker, startCamera as openCamera } from "../shared/hands.js";

// ---------- Config ----------
const PINCH_DOWN = 0.28;     // ratio below this -> mouse button down
const PINCH_UP = 0.42;       // ratio above this -> mouse button up (hysteresis)
const LIFT_GRACE_MS = 300;   // pointing pose may glitch this long before the pen lifts
const HAND_LOST_MS = 350;    // hand may vanish this long mid-stroke without ending it
const ERASER_SCALE = 0.9;    // eraser radius = hand size * this
const ERASE_HOLD = 4;        // open palm must be held this many frames before it erases

// Finger extension = dist(wrist, tip) / dist(wrist, knuckle)
const BEND_EXT = 75;         // total finger bend (deg) below this = straight
const BEND_CURL = 130;       // above this = folded

// ✋✊✋✊ toggle
const POSE_FRAMES = 3;       // a pose must be held this many frames to count
const SEQ_WINDOW = 2500;     // whole sequence must happen within this many ms
const TOGGLE_SEQ = ["open", "fist", "open", "fist"];

// Hand mouse
const CURSOR_SMOOTH = 0.7;

const COLORS = ["#ff3b6b", "#ffb020", "#ffe14d", "#3ddc84", "#33c3ff", "#9b6bff", "#ffffff"];

// Landmark indices (MediaPipe hand model)
const WRIST = 0, THUMB_TIP = 4, INDEX_TIP = 8, MIDDLE_MCP = 9;
const FINGERS = [ // [tip, knuckle]
  [8, 5], [12, 9], [16, 13], [20, 17],
];
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const video = $("video");
const paint = $("paint");
const overlay = $("overlay");
const pctx = paint.getContext("2d");
const octx = overlay.getContext("2d");
const statusEl = $("status");
const sizeEl = $("size");
const stabEl = $("stab");
const stabValEl = $("stabVal");
const startBtn = $("start");
const toastEl = $("toast");
const handCursor = $("handCursor");
const handRing = handCursor.querySelector(".ring");
const handMouseEl = $("handMouse");

// ---------- State ----------
let landmarker = null;
let color = COLORS[0];
let mode = "draw";         // "draw" | "erase"
let strokes = [];          // [{color, size, points:[{x,y}]}] — treated as immutable
let history = [];          // previous `strokes` arrays, for undo
let current = null;        // stroke in progress
let pinching = false;      // 🤏 = mouse button
let drawing = false;       // ☝️ = pen down
let graceSince = 0;        // when the pointing pose started glitching (0 = fine)
let lostSince = 0;         // when the hand disappeared mid-stroke (0 = visible)
let smoothed = null;       // filtered finger position
let pen = null;            // stabilized pen position (lazy brush)
let lastErase = null;      // previous eraser position (for sweep)
let openFrames = 0;        // consecutive frames with open palm
let erasedThisStroke = false;
let lastVideoTime = -1;

// pose sequence
let rawPose = null, rawCount = 0, stablePose = null;
let poseSeq = [];          // [{pose, t}]

// hand mouse
let cursor = null;         // screen position
let hoverEl = null;        // UI element under the hand cursor
let dragSlider = null;     // slider being dragged with a held pinch

// ---------- UI ----------
const colorsEl = $("colors");
COLORS.forEach((c, i) => {
  const s = document.createElement("div");
  s.className = "swatch" + (i === 0 ? " active" : "");
  s.style.background = c;
  s.title = "Color";
  s.onclick = () => {
    color = c;
    document.querySelectorAll(".swatch").forEach((el) => el.classList.remove("active"));
    s.classList.add("active");
    if (mode === "erase") setMode("draw");
  };
  colorsEl.appendChild(s);
});

// Stabilizer: (1) EMA smoothing, (2) lazy brush "string"
function stabSettings() {
  const t = +stabEl.value / 10;
  const scale = paint.width / 1280 || 1;
  return { alpha: 0.85 - 0.65 * t, radius: t * t * 40 * scale };
}
try {
  const saved = localStorage.getItem("airdraw.stab");
  if (saved !== null) stabEl.value = saved;
  const hm = localStorage.getItem("airdraw.handMouse");
  if (hm !== null) handMouseEl.checked = hm === "1";
} catch {}
stabValEl.textContent = stabEl.value;
stabEl.oninput = () => {
  stabValEl.textContent = stabEl.value;
  try { localStorage.setItem("airdraw.stab", stabEl.value); } catch {}
};
handMouseEl.onchange = () => {
  try { localStorage.setItem("airdraw.handMouse", handMouseEl.checked ? "1" : "0"); } catch {}
  if (!handMouseEl.checked) hideHandCursor();
};

$("mode").onclick = () => setMode(mode === "draw" ? "erase" : "draw");
$("undo").onclick = undo;
$("clear").onclick = clearAll;
$("save").onclick = save;
$("fullscreen").onclick = toggleFullscreen;
$("showVideo").onchange = (e) => video.classList.toggle("hidden", !e.target.checked);

window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  const k = e.key.toLowerCase();
  if (k === "e") setMode(mode === "draw" ? "erase" : "draw");
  if (k === "z") undo();
  if (k === "c") clearAll();
  if (k === "s") save();
  if (k === "f") toggleFullscreen();
});

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1200);
}

function setMode(m) {
  if (m === mode) return;
  endStroke();
  mode = m;
  document.body.classList.toggle("erase", mode === "erase");
  toast(mode === "erase" ? "🧽 Eraser mode" : "✏️ Draw mode");
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function setStrokes(next) {
  history.push(strokes);
  if (history.length > 100) history.shift();
  strokes = next;
  redraw();
}
function undo() {
  if (history.length) { strokes = history.pop(); redraw(); }
}
function clearAll() {
  current = null;
  if (strokes.length) setStrokes([]);
}

function save() {
  // Export un-mirrored so writing reads correctly
  const out = document.createElement("canvas");
  out.width = paint.width; out.height = paint.height;
  const c = out.getContext("2d");
  c.fillStyle = "#fff"; c.fillRect(0, 0, out.width, out.height);
  c.translate(out.width, 0); c.scale(-1, 1);
  c.drawImage(paint, 0, 0);
  const a = document.createElement("a");
  a.download = `air-draw-${Date.now()}.png`;
  a.href = out.toDataURL("image/png");
  a.click();
}

// ---------- Drawing ----------
function drawStroke(ctx, s) {
  const pts = s.points;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineWidth = s.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function redraw() {
  pctx.clearRect(0, 0, paint.width, paint.height);
  strokes.forEach((s) => drawStroke(pctx, s));
  if (current && current.points.length > 1) drawStroke(pctx, current);
}

function drawHand(lm, tint) {
  const W = overlay.width, H = overlay.height;
  octx.strokeStyle = tint;
  octx.lineWidth = 2;
  for (const [a, b] of HAND_CONNECTIONS) {
    octx.beginPath();
    octx.moveTo(lm[a].x * W, lm[a].y * H);
    octx.lineTo(lm[b].x * W, lm[b].y * H);
    octx.stroke();
  }
  octx.fillStyle = "rgba(255,255,255,0.8)";
  for (const p of lm) {
    octx.beginPath();
    octx.arc(p.x * W, p.y * H, 3, 0, Math.PI * 2);
    octx.fill();
  }
}

function drawPenCursor(p, down) {
  octx.beginPath();
  octx.arc(p.x, p.y, Math.max(6, +sizeEl.value / 2 + 4), 0, Math.PI * 2);
  if (down) { octx.fillStyle = color; octx.fill(); }
  else { octx.strokeStyle = color; octx.lineWidth = 3; octx.stroke(); }
}

function drawEraserCursor(p, r, down) {
  octx.beginPath();
  octx.arc(p.x, p.y, r, 0, Math.PI * 2);
  octx.fillStyle = down ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.08)";
  octx.fill();
  octx.setLineDash([8, 6]);
  octx.strokeStyle = "rgba(255,255,255,0.9)";
  octx.lineWidth = 2;
  octx.stroke();
  octx.setLineDash([]);
}

// ---------- Geometry ----------
const px = (p) => ({ x: p.x * paint.width, y: p.y * paint.height });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// Canvas pixel -> screen pixel (accounts for object-fit: cover + mirroring)
function toScreen(p) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const W = paint.width, H = paint.height;
  const s = Math.max(vw / W, vh / H);
  const ox = (vw - W * s) / 2, oy = (vh - H * s) / 2;
  return { x: vw - (p.x * s + ox), y: p.y * s + oy };
}

// ---------- Pose classification ----------
// Finger state from how much each finger bends at its joints, in 3D.
// Works even when pointing straight at the camera.
const CHAINS = [[0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]];
function bendAt(a, b, c) {
  const v1x = b.x - a.x, v1y = b.y - a.y, v1z = b.z - a.z;
  const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
  const n = Math.hypot(v1x, v1y, v1z) * Math.hypot(v2x, v2y, v2z) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y + v1z * v2z) / n))) * 180) / Math.PI;
}
function fingerStates(lm, world) {
  const P = world ? (i) => world[i] : (i) => ({ x: lm[i].x * paint.width, y: lm[i].y * paint.height, z: (lm[i].z || 0) * paint.width });
  return CHAINS.map((ch) => {
    let sum = 0;
    for (let k = 1; k < ch.length - 1; k++) sum += bendAt(P(ch[k - 1]), P(ch[k]), P(ch[k + 1]));
    return sum < BEND_EXT ? "ext" : sum > BEND_CURL ? "curl" : "mid";
  });
}
const isPointing = (f) => f[0] === "ext" && !f.slice(1).includes("ext") && f.slice(1).filter((x) => x === "curl").length >= 2;

function classify(f) {
  if (f.every((s) => s === "ext")) return "open";
  if (f.every((s) => s === "curl")) return "fist";
  if (isPointing(f)) return "point";
  return "other";
}

// Detect ✋✊✋✊ — when the sequence completes, returns the snapshot taken at the first ✊.
// Erasing BEFORE that fist was a real swipe (kept); only the 2nd ✋ can be accidental (undone).
function trackSequence(pose) {
  if (pose === rawPose) rawCount++;
  else { rawPose = pose; rawCount = 1; }

  if (rawCount !== POSE_FRAMES) return null;           // only act once per settled pose
  if (pose !== "open" && pose !== "fist") return null;  // in-between poses don't break the chain
  if (pose === stablePose) return null;
  stablePose = pose;

  const now = performance.now();
  poseSeq.push({ pose, t: now, snap: strokes, hist: history.length });
  poseSeq = poseSeq.filter((e) => now - e.t < SEQ_WINDOW).slice(-TOGGLE_SEQ.length);

  if (poseSeq.length === TOGGLE_SEQ.length && poseSeq.every((e, i) => e.pose === TOGGLE_SEQ[i])) {
    const firstFist = poseSeq[1];
    poseSeq = [];
    return firstFist;
  }
  return null;
}

function resetSequence() {
  rawPose = null; rawCount = 0; stablePose = null; poseSeq = [];
}

// ---------- Erasing ----------
function palmCenter(lm) {
  const pts = [0, 5, 9, 13, 17].map((i) => px(lm[i]));
  return {
    x: pts.reduce((a, p) => a + p.x, 0) / pts.length,
    y: pts.reduce((a, p) => a + p.y, 0) / pts.length,
  };
}

function eraseAlong(from, to, r) {
  let changed = false;
  const next = [];
  for (const s of strokes) {
    const hitR = r + s.size / 2;
    let piece = [];
    let cut = false;
    for (const p of s.points) {
      if (distToSegment(p, from, to) <= hitR) {
        cut = true;
        if (piece.length) next.push({ ...s, points: piece });
        piece = [];
      } else piece.push(p);
    }
    if (piece.length) next.push(cut ? { ...s, points: piece } : s);
    if (cut) changed = true;
  }
  if (!changed) return;
  if (!erasedThisStroke) { history.push(strokes); erasedThisStroke = true; }
  strokes = next;
  redraw();
}

// ---------- Hand mouse: move hand to aim, pinch 🤏 to click ----------
function clickableAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const slider = el.closest(".size");
  if (slider) return slider.querySelector("input[type=range]");
  return el.closest(".swatch, button, label.toggle, a.home");
}

function setHover(el) {
  if (hoverEl === el) return;
  hoverEl?.classList.remove("hand-hover");
  hoverEl = el;
  hoverEl?.classList.add("hand-hover");
}

function slideTo(el, x) {
  const r = el.getBoundingClientRect();
  const f = Math.max(0, Math.min(1, (x - r.left) / r.width));
  const v = Math.round(+el.min + f * (+el.max - +el.min));
  if (+el.value !== v) {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function updateHandMouse(lm, pinchDown, pinchUp) {
  // Cursor sits between thumb and index, so it barely moves when you pinch
  const t = px(lm[THUMB_TIP]), i = px(lm[INDEX_TIP]);
  const target = toScreen({ x: (t.x + i.x) / 2, y: (t.y + i.y) / 2 });
  cursor = cursor
    ? { x: cursor.x + (target.x - cursor.x) * CURSOR_SMOOTH, y: cursor.y + (target.y - cursor.y) * CURSOR_SMOOTH }
    : target;
  handCursor.classList.add("on");
  handCursor.style.transform = `translate(${cursor.x}px, ${cursor.y}px)`;
  handRing.style.setProperty("--p", pinching ? 1 : 0);

  if (pinchUp) dragSlider = null;
  if (dragSlider) {
    slideTo(dragSlider, cursor.x);   // keep dragging while the pinch is held
    return;
  }
  setHover(clickableAt(cursor.x, cursor.y));

  if (pinchDown && hoverEl) {
    if (hoverEl.type === "range") {
      dragSlider = hoverEl;
      slideTo(hoverEl, cursor.x);
    } else {
      const el = hoverEl;
      el.click();
      el.classList.add("hand-click");
      setTimeout(() => el.classList.remove("hand-click"), 150);
    }
  }
}

function hideHandCursor() {
  handCursor.classList.remove("on");
  setHover(null);
  cursor = null;
  dragSlider = null;
}

// ---------- Hand logic ----------
function handleHand(lm, world) {
  lostSince = 0;
  const fingers = fingerStates(lm, world);
  const pose = classify(fingers);

  // ✋✊✋✊ -> toggle eraser
  const toggled = trackSequence(pose);
  if (toggled) {
    // The 2nd ✋ of the gesture may have wiped a bit in eraser mode — put that back
    if (mode === "erase" && toggled.snap !== strokes) {
      strokes = toggled.snap;
      history.length = toggled.hist;
      redraw();
    }
    setMode(mode === "draw" ? "erase" : "draw");
  }
  openFrames = pose === "open" ? openFrames + 1 : 0;

  const thumb = px(lm[THUMB_TIP]);
  const index = px(lm[INDEX_TIP]);
  const handSize = dist(px(lm[WRIST]), px(lm[MIDDLE_MCP])) || 1;
  const ratio = dist(thumb, index) / handSize;

  // ----- 🤏 pinch = mouse button (with hysteresis) -----
  const wasPinching = pinching;
  const canPinch = pose !== "fist" && pose !== "open" && pose !== "point";
  if (!pinching && canPinch && ratio < PINCH_DOWN) pinching = true;
  else if (pinching && (ratio > PINCH_UP || pose === "fist" || pose === "open")) pinching = false;
  const pinchDown = pinching && !wasPinching;
  const pinchUp = !pinching && wasPinching;

  // ----- ☝️ pointing = pen down (with a little grace for tracking glitches) -----
  const now = performance.now();
  let penPaused = false;
  if (!drawing) {
    if (mode === "draw" && pose === "point" && !pinching) { drawing = true; graceSince = 0; }
  } else {
    const stillPointing = fingers[0] !== "curl" && !fingers.slice(1).includes("ext") && !pinching;
    if (mode !== "draw") drawing = false;
    else if (stillPointing) graceSince = 0;
    else {
      if (!graceSince) graceSince = now;
      if (now - graceSince > LIFT_GRACE_MS) drawing = false;
      else penPaused = true;   // hold the pen still while we wait to see if it was a glitch
    }
  }

  drawHand(lm, mode === "erase" ? "rgba(255,255,255,0.6)" : "rgba(0,255,200,0.6)");

  // ----- Eraser mode: open palm ✋ + swipe -----
  if (mode === "erase" && openFrames >= ERASE_HOLD) {
    hideHandCursor();
    pen = null; smoothed = null;
    const c = palmCenter(lm);
    const r = handSize * ERASER_SCALE;
    eraseAlong(lastErase || c, c, r);
    lastErase = c;
    drawEraserCursor(c, r, true);
    statusEl.textContent = "🧽 Erasing";
    return;
  }
  lastErase = null;
  erasedThisStroke = false;

  // ----- Draw mode: pen follows the index fingertip -----
  if (drawing) {
    hideHandCursor();
    const { alpha, radius } = stabSettings();
    smoothed = smoothed
      ? { x: smoothed.x + (index.x - smoothed.x) * alpha, y: smoothed.y + (index.y - smoothed.y) * alpha }
      : { ...index };
    if (!pen) pen = { ...smoothed };
    const d = dist(pen, smoothed);
    if (d > radius) {
      const k = (d - radius) / d;
      pen = { x: pen.x + (smoothed.x - pen.x) * k, y: pen.y + (smoothed.y - pen.y) * k };
    }
    if (!current) current = { color, size: +sizeEl.value, points: [{ ...pen }] };
    const last = current.points[current.points.length - 1];
    if (!penPaused && dist(last, pen) > 1.5) {
      current.points.push({ ...pen });
      redraw();
    }
    if (radius > 2) {
      octx.beginPath();
      octx.moveTo(smoothed.x, smoothed.y);
      octx.lineTo(pen.x, pen.y);
      octx.strokeStyle = "rgba(255,255,255,0.35)";
      octx.lineWidth = 1.5;
      octx.stroke();
    }
    drawPenCursor(pen, true);
    statusEl.textContent = "✏️ Drawing";
    return;
  }

  // ----- Not drawing / erasing: hover + hand mouse -----
  endStroke();
  smoothed = null; pen = null;
  if (handMouseEl.checked) updateHandMouse(lm, pinchDown, pinchUp);
  else {
    hideHandCursor();
    drawPenCursor(index, false);
  }
  if (mode === "erase") {
    drawEraserCursor(palmCenter(lm), handSize * ERASER_SCALE, false);
    statusEl.textContent = "🧽 Eraser — open palm ✋ to erase";
  } else {
    statusEl.textContent = pinching ? "🤏 Click" : pose === "fist" ? "✊" : "✋ Hovering";
  }
}

// Finish the current stroke / erase swipe
function endStroke() {
  lastErase = null;
  erasedThisStroke = false;
  if (current) {
    const done = current;
    current = null;
    if (done.points.length > 1) setStrokes([...strokes, done]);
    else redraw();
  }
}

// ---------- Main loop ----------
function loop() {
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    octx.clearRect(0, 0, overlay.width, overlay.height);

    if (res.landmarks && res.landmarks.length) {
      handleHand(res.landmarks[0], res.worldLandmarks?.[0]);
    } else if (drawing && (lostSince === 0 || performance.now() - lostSince < HAND_LOST_MS)) {
      // Tracking dropped for a moment mid-stroke: keep the stroke alive
      if (!lostSince) lostSince = performance.now();
      if (pen) drawPenCursor(pen, true);
      statusEl.textContent = "✏️ Drawing…";
    } else {
      lostSince = 0;
      pinching = false;
      drawing = false;
      smoothed = null;
      pen = null;
      endStroke();
      hideHandCursor();
      resetSequence();
      openFrames = 0;
      statusEl.textContent = "No hand detected";
    }
  }
  requestAnimationFrame(loop);
}

// ---------- Setup ----------
async function init() {
  landmarker = await createHandLandmarker();   // smoothed (One-Euro) + tuned tracking
  statusEl.textContent = "Model ready — start camera";
}

function fitCanvases() {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H || (W === paint.width && H === paint.height)) return;
  const oldW = paint.width, oldH = paint.height;
  for (const c of [paint, overlay]) { c.width = W; c.height = H; }
  if (strokes.length && oldW > 0 && oldH > 0) {
    const sx = W / oldW, sy = H / oldH;
    const scale = (list) => list.map((s) => ({ ...s, points: s.points.map((p) => ({ x: p.x * sx, y: p.y * sy })) }));
    strokes = scale(strokes);
    history = history.map(scale);
  }
  current = null;
  smoothed = null; pen = null;
  redraw();
}

async function startCamera() {
  startBtn.disabled = true;
  try {
    await openCamera(video);
    fitCanvases();
    // Phone/iPad rotated -> camera resolution flips; rescale the drawing to match
    video.addEventListener("resize", fitCanvases);
    $("intro").classList.add("gone");
    await modelReady;
    loop();
  } catch (err) {
    statusEl.textContent = "Camera error: " + err.message;
    startBtn.disabled = false;
  }
}

const modelReady = init().catch((err) => {
  statusEl.textContent = "Couldn't load hand tracking. Check your internet and reload.";
  throw err;
});
modelReady.catch(() => {}); // handled above; startCamera() reports it too
startBtn.onclick = startCamera;

// Shared hand-tracking helpers for every Handheld game.
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

export const LM = {
  WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_TIP: 8, MIDDLE_MCP: 9, MIDDLE_TIP: 12,
  RING_MCP: 13, PINKY_MCP: 17,
};
export const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];

// ---------- One-Euro filter ----------
// The standard filter for hand tracking: smooths heavily when the hand is still
// (kills jitter) and almost not at all when it moves fast (no lag).
const lpAlpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = 0;
  }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(0.001, (t - this.t) / 1000);
    this.t = t;
    const d = (v - this.x) / dt;
    this.dx += lpAlpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += lpAlpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

// Tuning (exposed so games can tweak): screen landmarks are 0..1, world landmarks are metres.
export const SMOOTHING = {
  screen: { minCutoff: 1.2, beta: 14 },
  world: { minCutoff: 1.2, beta: 25 },
  coastMs: 120,   // keep the last hand this long if tracking drops a frame
  resetMs: 300,   // after this long without a hand, start fresh (no "slide in" from old spot)
};

const make21 = ({ minCutoff, beta }) =>
  Array.from({ length: 21 }, () => [new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta)]);

/** Wraps a HandLandmarker: same detectForVideo() API, but returns filtered landmarks. */
class SmoothedLandmarker {
  constructor(raw) {
    this.raw = raw;
    this.f = null; this.wf = null;
    this.last = null; this.lastSeen = -Infinity;
  }
  detectForVideo(video, ts) {
    const r = this.raw.detectForVideo(video, ts);
    const lm = r.landmarks?.[0];
    if (lm) {
      if (!this.f || ts - this.lastSeen > SMOOTHING.resetMs) {
        this.f = make21(SMOOTHING.screen);
        this.wf = make21(SMOOTHING.world);
      }
      const run = (pts, F) => pts.map((p, i) => ({
        x: F[i][0].filter(p.x, ts), y: F[i][1].filter(p.y, ts), z: F[i][2].filter(p.z || 0, ts),
      }));
      const wl = r.worldLandmarks?.[0];
      this.last = {
        landmarks: [run(lm, this.f), ...r.landmarks.slice(1)],
        worldLandmarks: wl ? [run(wl, this.wf), ...r.worldLandmarks.slice(1)] : [],
        handedness: r.handedness,
      };
      this.lastSeen = ts;
      return this.last;
    }
    if (this.last && ts - this.lastSeen < SMOOTHING.coastMs) return { ...this.last, coasting: true };
    return { landmarks: [], worldLandmarks: [], handedness: [] };
  }
}

export async function createHandLandmarker({ numHands = 1, smooth = true } = {}) {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numHands,
    // Lower presence/tracking thresholds = keep following the hand instead of
    // dropping it and re-running the slower full-image palm search (a big source of glitches).
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
  });
  let raw;
  try {
    raw = await HandLandmarker.createFromOptions(vision, opts("GPU"));
  } catch {
    raw = await HandLandmarker.createFromOptions(vision, opts("CPU"));
  }
  return smooth ? new SmoothedLandmarker(raw) : raw;
}

export async function startCamera(video) {
  // 960x540 is plenty for hand tracking and much cheaper per frame than 1280x720
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 60, max: 60 } },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((r) => (video.readyState >= 2 ? r() : (video.onloadeddata = r)));
  await video.play().catch(() => {});
  return stream;
}

/** Runs `onFrame(result, now)` once per new camera frame. Returns a stop function. */
export function runLoop(video, landmarker, onFrame) {
  let last = -1, raf = 0, running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    if (video.currentTime !== last && video.readyState >= 2) {
      last = video.currentTime;
      onFrame(landmarker.detectForVideo(video, now), now);
    } else {
      onFrame(null, now); // no new camera frame: still animate
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => { running = false; cancelAnimationFrame(raf); };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Maps a normalized landmark to screen pixels for a full-screen, mirrored,
 * object-fit: cover video. Use with a canvas that is NOT mirrored.
 */
export function screenMapper(video) {
  return (p) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const W = video.videoWidth || 1280, H = video.videoHeight || 720;
    const s = Math.max(vw / W, vh / H);
    const ox = (vw - W * s) / 2, oy = (vh - H * s) / 2;
    return { x: vw - (p.x * W * s + ox), y: p.y * H * s + oy };
  };
}

// Finger state from how much each finger BENDS at its joints, measured in 3D.
// This works even when you point straight at the camera (where the finger looks
// short on screen but is actually straight).
const CHAINS = [[0, 5, 6, 7, 8], [0, 9, 10, 11, 12], [0, 13, 14, 15, 16], [0, 17, 18, 19, 20]];
export const BEND_EXT = 75;   // total bend (degrees) below this = straight
export const BEND_CURL = 130; // above this = folded

function bendAt(a, b, c) {
  const v1x = b.x - a.x, v1y = b.y - a.y, v1z = b.z - a.z;
  const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
  const n = Math.hypot(v1x, v1y, v1z) * Math.hypot(v2x, v2y, v2z) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y + v1z * v2z) / n))) * 180) / Math.PI;
}

/** Total bend in degrees for index, middle, ring, pinky. Uses 3D world landmarks when given. */
export function fingerBends(lm, W = 1280, H = 720, world = null) {
  const P = world ? (i) => world[i] : (i) => ({ x: lm[i].x * W, y: lm[i].y * H, z: (lm[i].z || 0) * W });
  return CHAINS.map((ch) => {
    let sum = 0;
    for (let k = 1; k < ch.length - 1; k++) sum += bendAt(P(ch[k - 1]), P(ch[k]), P(ch[k + 1]));
    return sum;
  });
}

/** "ext" | "mid" | "curl" for index, middle, ring, pinky */
export function fingerStates(lm, W = 1280, H = 720, world = null) {
  return fingerBends(lm, W, H, world).map((b) => (b < BEND_EXT ? "ext" : b > BEND_CURL ? "curl" : "mid"));
}

/** Index straight, other fingers not straight (at least two clearly folded). */
export function isPointing(f) {
  const rest = f.slice(1);
  return f[0] === "ext" && !rest.includes("ext") && rest.filter((s) => s === "curl").length >= 2;
}

/** "open" | "fist" | "point" | "peace" | "other" */
export function classifyPose(f) {
  if (f.every((s) => s === "ext")) return "open";
  if (f.every((s) => s === "curl")) return "fist";
  if (isPointing(f)) return "point";
  if (f[0] === "ext" && f[1] === "ext" && f[2] === "curl" && f[3] === "curl") return "peace";
  return "other";
}

/** Thumb–index distance relative to hand size (small = pinching). */
export function pinchRatio(lm, W = 1280, H = 720) {
  const P = (i) => ({ x: lm[i].x * W, y: lm[i].y * H });
  return dist(P(4), P(8)) / (dist(P(0), P(9)) || 1);
}

/** Holds a pose only after it's been seen for `frames` frames in a row. */
export class PoseFilter {
  constructor(frames = 3) { this.frames = frames; this.raw = null; this.count = 0; this.stable = null; }
  update(pose) {
    if (pose === this.raw) this.count++;
    else { this.raw = pose; this.count = 1; }
    if (this.count >= this.frames) this.stable = pose;
    return this.stable;
  }
  reset() { this.raw = null; this.count = 0; this.stable = null; }
}

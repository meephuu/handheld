// Rune shapes + a small orientation-aware stroke recognizer (based on the $1 Unistroke idea).
// Unlike classic $1 it does NOT rotate strokes to a canonical angle, so a vertical zigzag
// and a horizontal line stay different spells. Closed shapes (circle, triangle) are
// matched from any starting point and in either direction.

const N = 64;

function polyline(pts, n = 120) {
  // Densify a list of corner points into a smooth path
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const steps = Math.max(2, Math.round(n / (pts.length - 1)));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function circlePts() {
  const out = [];
  for (let i = 0; i <= 64; i++) {
    const a = -Math.PI / 2 + (i / 64) * Math.PI * 2;
    out.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  return out;
}

// Spell catalog. `glyph` = the shape you draw (unit coords, y down).
export const SPELLS = {
  protego: {
    name: "Protego", desc: "Shield", color: "#ffd166", glow: "255,209,102",
    closed: true, glyph: circlePts(),
  },
  incendio: {
    name: "Incendio", desc: "Fire", color: "#ff7a2f", glow: "255,122,47",
    closed: true,
    glyph: polyline([{ x: 0, y: -1 }, { x: 0.9, y: 0.65 }, { x: -0.9, y: 0.65 }, { x: 0, y: -1 }]),
  },
  fulgur: {
    name: "Fulgur", desc: "Lightning", color: "#8ad8ff", glow: "138,216,255",
    closed: false,
    glyph: polyline([{ x: -0.45, y: -1 }, { x: 0.45, y: -0.35 }, { x: -0.45, y: 0.35 }, { x: 0.45, y: 1 }]),
  },
  glacius: {
    name: "Glacius", desc: "Ice", color: "#9ffcff", glow: "159,252,255",
    closed: false,
    glyph: polyline([{ x: -0.75, y: -0.9 }, { x: 0, y: 0.9 }, { x: 0.75, y: -0.9 }]),
  },
  expelliarmus: {
    name: "Expelliarmus", desc: "Disarm", color: "#ff4d6d", glow: "255,77,109",
    closed: false,
    glyph: polyline([{ x: -1, y: 0 }, { x: 1, y: 0 }]),
  },
};
export const SPELL_IDS = Object.keys(SPELLS);

// ---------- geometry ----------
const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function pathLength(p) { let L = 0; for (let i = 1; i < p.length; i++) L += d2(p[i - 1], p[i]); return L; }

function resample(points, n = N) {
  const pts = points.map((p) => ({ ...p }));
  const I = pathLength(pts) / (n - 1);
  if (I === 0) return Array.from({ length: n }, () => ({ ...pts[0] }));
  let D = 0;
  const out = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    const d = d2(pts[i - 1], pts[i]);
    if (D + d >= I) {
      const t = (I - D) / d;
      const q = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y) };
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}

function normalize(points) {
  // Uniform scale keeps aspect ratio (a line stays a line)
  const p = resample(points);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0;
  for (const q of p) {
    minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
    cx += q.x; cy += q.y;
  }
  cx /= p.length; cy /= p.length;
  const s = Math.max(maxX - minX, maxY - minY) || 1;
  return p.map((q) => ({ x: (q.x - cx) / s, y: (q.y - cy) / s }));
}

function rotate(p, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return p.map((q) => ({ x: q.x * c - q.y * s, y: q.x * s + q.y * c }));
}

function avgDist(a, b, shift = 0) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += d2(a[(i + shift) % a.length], b[i]);
  return d / a.length;
}

// Each spell accepts several variations of its shape, so you don't have to draw it perfectly.
function arc(startDeg, sweepDeg, sx = 1, sy = 1) {
  const out = [];
  for (let i = 0; i <= 48; i++) {
    const a = ((startDeg + (sweepDeg * i) / 48) * Math.PI) / 180;
    out.push({ x: Math.cos(a) * sx, y: Math.sin(a) * sy });
  }
  return out;
}
const TRI = [{ x: 0, y: -1 }, { x: 0.9, y: 0.65 }, { x: -0.9, y: 0.65 }];
const openTri = (k) => {          // triangle starting at vertex k, last side left 70% drawn
  const a = TRI[k], b = TRI[(k + 1) % 3], c = TRI[(k + 2) % 3];
  return polyline([a, b, c, { x: c.x + (a.x - c.x) * 0.7, y: c.y + (a.y - c.y) * 0.7 }]);
};
const VARIANTS = {
  protego: [
    { closed: true, pts: SPELLS.protego.glyph },
    { closed: true, pts: arc(0, 360, 1.35, 1) },            // wide ellipse
    { closed: true, pts: arc(0, 360, 1, 1.35) },            // tall ellipse
    ...[-90, 0, 90, 180].map((st) => ({ closed: false, pts: arc(st, 290) })), // not fully closed
  ],
  incendio: [
    { closed: true, pts: SPELLS.incendio.glyph },
    { closed: true, pts: polyline([{ x: 0, y: -0.55 }, { x: 1.2, y: 0.55 }, { x: -1.2, y: 0.55 }, { x: 0, y: -0.55 }]) }, // flat triangle
    ...[0, 1, 2].map((k) => ({ closed: false, pts: openTri(k) })),
  ],
  fulgur: [
    { closed: false, pts: SPELLS.fulgur.glyph },
    { closed: false, pts: polyline([{ x: 0.45, y: -1 }, { x: -0.45, y: -0.35 }, { x: 0.45, y: 0.35 }, { x: -0.45, y: 1 }]) }, // mirrored
    { closed: false, pts: polyline([{ x: -0.9, y: -0.7 }, { x: 0.9, y: -0.7 }, { x: -0.9, y: 0.7 }, { x: 0.9, y: 0.7 }]) },   // Z
    { closed: false, pts: polyline([{ x: 0.35, y: -1 }, { x: -0.3, y: 0.05 }, { x: 0.3, y: -0.05 }, { x: -0.35, y: 1 }]) }, // bolt ⚡
  ],
  glacius: [
    { closed: false, pts: SPELLS.glacius.glyph },
    { closed: false, pts: polyline([{ x: -0.45, y: -0.9 }, { x: 0, y: 0.9 }, { x: 0.45, y: -0.9 }]) }, // narrow V
    { closed: false, pts: polyline([{ x: -1, y: -0.6 }, { x: 0, y: 0.6 }, { x: 1, y: -0.6 }]) },       // wide V
  ],
  expelliarmus: [{ closed: false, pts: SPELLS.expelliarmus.glyph }],
};
const TEMPLATES = Object.entries(VARIANTS).flatMap(([id, list]) =>
  list.map((v) => ({ id, closed: v.closed, pts: normalize(v.pts) })));
const ANGLES = [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]; // ±34° tolerance for tilted drawing

/** Best match distance for every spell. */
function scoreAll(points) {
  const base = normalize(points);
  const cands = [base, [...base].reverse()].flatMap((c) => ANGLES.map((a) => rotate(c, a)));
  const best = {};
  for (const t of TEMPLATES) {
    let d = best[t.id] ?? Infinity;
    for (const c of cands) {
      if (t.closed) {
        for (let sh = 0; sh < N; sh += 2) d = Math.min(d, avgDist(c, t.pts, sh));
      } else d = Math.min(d, avgDist(c, t.pts));
    }
    best[t.id] = d;
  }
  const scores = {};
  for (const id in best) scores[id] = 1 - best[id] / 0.35;
  return scores;
}

/**
 * Recognize a stroke. Returns { id, score, assisted } or null.
 *  - minScore: how close a shape must be to count on its own
 *  - prefer: spells that are useful right now (runes on wraiths). If one of them is
 *    nearly as good as the best guess, it wins ("aim assist"); it can also rescue a
 *    sloppy shape down to assistMin.
 */
export function recognize(points, { minScore = 0.55, prefer = [], assistMargin = 0.15, assistMin = 0.42 } = {}) {
  if (points.length < 6) return null;
  const scores = scoreAll(points);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestId, bestScore] = ranked[0];
  const pref = ranked.find(([id]) => prefer.includes(id));
  if (pref && pref[0] !== bestId && pref[1] >= assistMin && pref[1] >= bestScore - assistMargin) {
    return { id: pref[0], score: pref[1], assisted: true };
  }
  if (bestScore >= minScore) return { id: bestId, score: bestScore, assisted: false };
  if (pref && pref[1] >= assistMin) return { id: pref[0], score: pref[1], assisted: true };
  return null;
}

/** Draw a spell's glyph as a glowing rune. */
export function drawGlyph(ctx, id, cx, cy, size, alpha = 1, width = 3) {
  const sp = SPELLS[id];
  const pts = sp.glyph;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [w, a] of [[width * 4, 0.12], [width * 2, 0.35], [width, 1]]) {
    ctx.strokeStyle = a === 1 ? `rgba(255,255,255,${alpha})` : `rgba(${sp.glow},${a * alpha})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(cx + p.x * size, cy + p.y * size) : ctx.moveTo(cx + p.x * size, cy + p.y * size)));
    ctx.stroke();
  }
  ctx.restore();
}

/** Glyph as an SVG path string (for the spellbook UI). */
export function glyphSvg(id, size = 48) {
  const pts = SPELLS[id].glyph;
  const h = size / 2, s = size * 0.38;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><path d="${pts
    .map((p, i) => `${i ? "L" : "M"}${(h + p.x * s).toFixed(1)} ${(h + p.y * s).toFixed(1)}`)
    .join(" ")}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

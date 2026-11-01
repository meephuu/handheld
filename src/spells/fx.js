// Lightweight 2D VFX engine: additive glow particles, lightning, beams, rings, flashes.

const glowCache = new Map();
/** Soft round glow sprite (cached per color). */
export function glowSprite(rgb) {
  if (glowCache.has(rgb)) return glowCache.get(rgb);
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.18, `rgba(${rgb},0.9)`);
  grd.addColorStop(0.45, `rgba(${rgb},0.25)`);
  grd.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  glowCache.set(rgb, c);
  return c;
}

let smokeSprite = null;
function getSmoke() {
  if (smokeSprite) return smokeSprite;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.2)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return (smokeSprite = c);
}
// tinted smoke sprites
const smokeCache = new Map();
function tintedSmoke(rgb) {
  if (smokeCache.has(rgb)) return smokeCache.get(rgb);
  const base = getSmoke();
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.drawImage(base, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = `rgb(${rgb})`;
  g.fillRect(0, 0, 64, 64);
  smokeCache.set(rgb, c);
  return c;
}

const rand = (a, b) => a + Math.random() * (b - a);
export { rand };

// Fire colour ramp over particle life (0 = birth, 1 = death)
const FIRE = [[255, 255, 230], [255, 220, 120], [255, 140, 40], [220, 60, 20], [80, 30, 20]];
function ramp(stops, t) {
  const f = Math.min(0.999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(f), k = f - i;
  const a = stops[i], b = stops[i + 1];
  return `${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)}`;
}

export class FX {
  constructor(ctx) {
    this.ctx = ctx;
    this.particles = [];
    this.bolts = [];
    this.beams = [];
    this.rings = [];
    this.texts = [];
    this.flashes = [];
    this.shields = [];
    this.shake = 0;
    this.MAX = 2200;
  }

  // ---------- emitters ----------
  /** type: "glow" (additive), "fire", "smoke", "shard", "spark" */
  add(p) {
    if (this.particles.length >= this.MAX) this.particles.shift();
    p.life = 0;
    p.max ??= 1;
    p.drag ??= 0.98;
    p.g ??= 0;
    p.size ??= 10;
    p.grow ??= 0;
    p.rot ??= 0;
    p.vr ??= 0;
    this.particles.push(p);
  }

  sparkle(x, y, rgb, n = 2, speed = 1.5, size = 8) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), v = rand(0.2, speed);
      this.add({ type: "glow", rgb, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.3, size: rand(size * 0.4, size), max: rand(0.4, 0.9), g: 0.02 });
    }
  }

  burst(x, y, rgb, n = 60, speed = 9, size = 14) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), v = rand(speed * 0.2, speed);
      this.add({ type: "glow", rgb, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: rand(size * 0.4, size), max: rand(0.5, 1.1), drag: 0.93, g: 0.05 });
    }
  }

  fire(x, y, n = 6, spread = 6, up = 2.5, size = 26) {
    for (let i = 0; i < n; i++) {
      this.add({
        type: "fire", x: x + rand(-spread, spread), y: y + rand(-spread, spread),
        vx: rand(-1, 1), vy: -rand(up * 0.4, up), size: rand(size * 0.5, size), grow: -0.15,
        max: rand(0.45, 0.9), drag: 0.97, g: -0.04,
      });
    }
  }

  explosion(x, y, scale = 1) {
    for (let i = 0; i < 90 * scale; i++) {
      const a = rand(0, Math.PI * 2), v = rand(1, 11) * scale;
      this.add({ type: "fire", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: rand(18, 46) * scale, grow: -0.2, max: rand(0.5, 1.1), drag: 0.9, g: -0.05 });
    }
    for (let i = 0; i < 25 * scale; i++) {
      const a = rand(0, Math.PI * 2), v = rand(0.5, 4) * scale;
      this.add({ type: "smoke", rgb: "40,30,30", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1, size: rand(30, 60) * scale, grow: 0.8, max: rand(1, 1.8), drag: 0.95, alpha: 0.6 });
    }
    this.burst(x, y, "255,200,120", 40 * scale, 14 * scale, 8);
    this.ring(x, y, "255,150,60", 140 * scale, 0.45, 6);
    this.flash("255,140,40", 0.25 * scale);
    this.shake = Math.max(this.shake, 14 * scale);
  }

  smoke(x, y, rgb = "30,24,40", n = 8, size = 40, alpha = 0.5, spread = 10) {
    for (let i = 0; i < n; i++) {
      this.add({ type: "smoke", rgb, x: x + rand(-spread, spread), y: y + rand(-spread, spread), vx: rand(-0.8, 0.8), vy: rand(-1.2, -0.2), size: rand(size * 0.5, size), grow: 0.6, max: rand(0.8, 1.6), drag: 0.97, alpha });
    }
  }

  shards(x, y, n = 18, speed = 12) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), v = rand(speed * 0.3, speed);
      this.add({ type: "shard", rgb: "180,250,255", x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, size: rand(8, 20), max: rand(0.6, 1.2), drag: 0.93, g: 0.25, rot: a, vr: rand(-0.3, 0.3) });
    }
  }

  ring(x, y, rgb, radius, dur = 0.5, width = 4) {
    this.rings.push({ x, y, rgb, radius, dur, width, t: 0 });
  }

  flash(rgb, alpha = 0.4) {
    this.flashes.push({ rgb, alpha, t: 0, dur: 0.35 });
  }

  text(x, y, str, color = "#fff", size = 28) {
    this.texts.push({ x, y, str, color, size, t: 0, dur: 1.1 });
  }

  /** Jagged lightning between two points (with branches). */
  lightning(x1, y1, x2, y2, rgb = "138,216,255", dur = 0.45) {
    const make = (a, b, disp, depth) => {
      let pts = [a, b];
      let d = disp;
      for (let k = 0; k < 7; k++) {
        const next = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
          const nx = -(q.y - p.y), ny = q.x - p.x, nl = Math.hypot(nx, ny) || 1;
          const off = rand(-d, d);
          next.push({ x: mx + (nx / nl) * off, y: my + (ny / nl) * off }, q);
        }
        pts = next;
        d *= 0.55;
      }
      const branches = [];
      if (depth < 2) {
        for (let i = 0; i < 3; i++) {
          const s = pts[Math.floor(rand(0.2, 0.8) * pts.length)];
          const ang = Math.atan2(b.y - a.y, b.x - a.x) + rand(-0.9, 0.9);
          const len = Math.hypot(b.x - a.x, b.y - a.y) * rand(0.15, 0.35);
          branches.push(make(s, { x: s.x + Math.cos(ang) * len, y: s.y + Math.sin(ang) * len }, disp * 0.4, depth + 1));
        }
      }
      return { pts, branches };
    };
    const disp = Math.hypot(x2 - x1, y2 - y1) * 0.18;
    this.bolts.push({ tree: make({ x: x1, y: y1 }, { x: x2, y: y2 }, disp, 0), rgb, t: 0, dur });
    this.flash("200,230,255", 0.45);
    this.shake = Math.max(this.shake, 12);
  }

  beam(x1, y1, x2, y2, rgb = "255,77,109", dur = 0.45, width = 10) {
    this.beams.push({ x1, y1, x2, y2, rgb, dur, width, t: 0 });
  }

  shield(x, y, r, dur = 1.6) {
    this.shields.push({ x, y, r, t: 0, dur });
  }

  // ---------- update + draw ----------
  update(dt) {
    const k = dt * 60; // normalise to 60 fps
    for (const p of this.particles) {
      p.life += dt / p.max;
      p.vx *= Math.pow(p.drag, k);
      p.vy *= Math.pow(p.drag, k);
      p.vy += p.g * k;
      p.x += p.vx * k;
      p.y += p.vy * k;
      p.size = Math.max(0.5, p.size + p.grow * k);
      p.rot += p.vr * k;
    }
    this.particles = this.particles.filter((p) => p.life < 1);
    for (const list of [this.bolts, this.beams, this.rings, this.texts, this.flashes, this.shields]) {
      for (const e of list) e.t += dt;
    }
    this.bolts = this.bolts.filter((e) => e.t < e.dur);
    this.beams = this.beams.filter((e) => e.t < e.dur);
    this.rings = this.rings.filter((e) => e.t < e.dur);
    this.texts = this.texts.filter((e) => e.t < e.dur);
    this.flashes = this.flashes.filter((e) => e.t < e.dur);
    this.shields = this.shields.filter((e) => e.t < e.dur);
    this.shake *= Math.pow(0.88, k);
    if (this.shake < 0.3) this.shake = 0;
  }

  shakeOffset() {
    return this.shake ? { x: rand(-this.shake, this.shake), y: rand(-this.shake, this.shake) } : { x: 0, y: 0 };
  }

  draw() {
    const c = this.ctx;
    // smoke first (normal blending), everything bright on top (additive)
    for (const p of this.particles) {
      if (p.type !== "smoke") continue;
      const a = (p.alpha ?? 0.5) * Math.sin(Math.PI * Math.min(1, p.life * 1.2 + 0.05));
      c.globalAlpha = Math.max(0, a);
      const s = p.size * 2;
      c.drawImage(tintedSmoke(p.rgb), p.x - s / 2, p.y - s / 2, s, s);
    }
    c.globalAlpha = 1;

    c.globalCompositeOperation = "lighter";
    for (const p of this.particles) {
      const fade = 1 - p.life;
      if (p.type === "glow" || p.type === "spark") {
        c.globalAlpha = fade;
        const s = p.size * 2;
        c.drawImage(glowSprite(p.rgb), p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.type === "fire") {
        c.globalAlpha = Math.min(1, fade * 1.4) * 0.85;
        const s = p.size * 2;
        // quantised so only ~25 cached sprites are ever created
        c.drawImage(glowSprite(ramp(FIRE, Math.round(p.life * 24) / 24)), p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.type === "shard") {
        c.globalAlpha = fade;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);
        c.fillStyle = `rgba(${p.rgb},0.9)`;
        c.beginPath();
        c.moveTo(p.size, 0);
        c.lineTo(0, p.size * 0.22);
        c.lineTo(-p.size * 0.5, 0);
        c.lineTo(0, -p.size * 0.22);
        c.closePath();
        c.fill();
        c.restore();
        const s = p.size * 1.6;
        c.globalAlpha = fade * 0.5;
        c.drawImage(glowSprite(p.rgb), p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    c.globalAlpha = 1;

    // rings
    for (const r of this.rings) {
      const t = r.t / r.dur, e = 1 - Math.pow(1 - t, 3);
      c.strokeStyle = `rgba(${r.rgb},${(1 - t) * 0.9})`;
      c.lineWidth = r.width * (1 - t) + 1;
      c.beginPath();
      c.arc(r.x, r.y, r.radius * e, 0, Math.PI * 2);
      c.stroke();
    }

    // shields: shimmering dome with hex-like rim pulses
    for (const s of this.shields) {
      const t = s.t / s.dur;
      const appear = Math.min(1, s.t / 0.18);
      const alpha = appear * (t > 0.75 ? (1 - t) / 0.25 : 1);
      const r = s.r * (0.85 + 0.15 * appear);
      const grd = c.createRadialGradient(s.x, s.y, r * 0.55, s.x, s.y, r);
      grd.addColorStop(0, "rgba(255,209,102,0)");
      grd.addColorStop(0.85, `rgba(255,209,102,${0.18 * alpha})`);
      grd.addColorStop(1, `rgba(255,240,200,${0.55 * alpha})`);
      c.fillStyle = grd;
      c.beginPath();
      c.arc(s.x, s.y, r, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const rr = r * (0.6 + ((s.t * 0.6 + i / 3) % 1) * 0.4);
        c.strokeStyle = `rgba(255,225,150,${0.35 * alpha})`;
        c.beginPath();
        c.arc(s.x, s.y, rr, 0, Math.PI * 2);
        c.stroke();
      }
      // runic ticks spinning on the rim
      c.strokeStyle = `rgba(255,245,210,${0.8 * alpha})`;
      c.lineWidth = 2.5;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2 + s.t * 0.8;
        c.beginPath();
        c.moveTo(s.x + Math.cos(a) * r * 0.94, s.y + Math.sin(a) * r * 0.94);
        c.lineTo(s.x + Math.cos(a) * r * (i % 3 ? 0.98 : 1.04), s.y + Math.sin(a) * r * (i % 3 ? 0.98 : 1.04));
        c.stroke();
      }
    }

    // beams: wobbling core with glow layers
    for (const b of this.beams) {
      const t = b.t / b.dur;
      const w = b.width * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
      const pts = [];
      const steps = 24;
      const nx = -(b.y2 - b.y1), ny = b.x2 - b.x1, nl = Math.hypot(nx, ny) || 1;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const wob = Math.sin(f * 20 + b.t * 50) * 4 * Math.sin(f * Math.PI);
        pts.push({ x: b.x1 + (b.x2 - b.x1) * f + (nx / nl) * wob, y: b.y1 + (b.y2 - b.y1) * f + (ny / nl) * wob });
      }
      c.lineCap = "round";
      for (const [lw, col] of [[w * 4, `rgba(${b.rgb},0.15)`], [w * 2, `rgba(${b.rgb},0.45)`], [w, `rgba(${b.rgb},0.95)`], [w * 0.35, "rgba(255,255,255,1)"]]) {
        c.strokeStyle = col;
        c.lineWidth = Math.max(0.5, lw);
        c.beginPath();
        pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
        c.stroke();
      }
    }

    // lightning: flicker + glow passes
    for (const bolt of this.bolts) {
      const t = bolt.t / bolt.dur;
      if (Math.random() < 0.15 && t > 0.3) continue; // flicker
      const a = 1 - t;
      const drawTree = (node, scale) => {
        for (const [lw, col] of [[14 * scale, `rgba(${bolt.rgb},${0.12 * a})`], [6 * scale, `rgba(${bolt.rgb},${0.5 * a})`], [2.2 * scale, `rgba(255,255,255,${a})`]]) {
          c.strokeStyle = col;
          c.lineWidth = lw;
          c.lineJoin = "round";
          c.beginPath();
          node.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
          c.stroke();
        }
        node.branches.forEach((b) => drawTree(b, scale * 0.55));
      };
      drawTree(bolt.tree, 1);
    }
    c.globalCompositeOperation = "source-over";

    // floating text
    for (const tx of this.texts) {
      const t = tx.t / tx.dur;
      c.globalAlpha = 1 - t * t;
      c.font = `700 ${tx.size}px Cinzel, Georgia, serif`;
      c.textAlign = "center";
      c.fillStyle = tx.color;
      c.shadowColor = "rgba(0,0,0,0.8)";
      c.shadowBlur = 8;
      c.fillText(tx.str, tx.x, tx.y - t * 50);
      c.shadowBlur = 0;
    }
    c.globalAlpha = 1;

    // screen flashes
    for (const f of this.flashes) {
      const t = f.t / f.dur;
      c.fillStyle = `rgba(${f.rgb},${f.alpha * (1 - t)})`;
      c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    }
  }
}

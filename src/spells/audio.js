// Tiny synthesized sound effects (no audio files needed).
let ctx = null;
let muted = false;
try { muted = localStorage.getItem("vision.muted") === "1"; } catch {}

export function isMuted() { return muted; }
export function setMuted(m) {
  muted = m;
  try { localStorage.setItem("vision.muted", m ? "1" : "0"); } catch {}
}
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  ctx?.resume?.();
}

function noise(dur) {
  const b = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * dur), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource();
  s.buffer = b;
  return s;
}
function env(node, t0, a, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  node.connect(g);
  g.connect(ctx.destination);
  return g;
}
function tone(type, f1, f2, dur, peak = 0.2, delay = 0) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  env(o, t, 0.01, peak, dur);
  o.start(t);
  o.stop(t + dur + 0.05);
}
function hiss(dur, freq, q, peak = 0.3, type = "bandpass", sweepTo = null, delay = 0) {
  const t = ctx.currentTime + delay;
  const n = noise(dur);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
  f.Q.value = q;
  n.connect(f);
  env(f, t, 0.02, peak, dur);
  n.start(t);
}

export const sfx = {
  cast(id) {
    if (muted || !ctx) return;
    switch (id) {
      case "incendio": hiss(0.9, 600, 0.7, 0.5, "lowpass", 200); tone("sawtooth", 120, 40, 0.6, 0.08); break;
      case "fulgur": hiss(0.12, 3000, 0.5, 0.6, "highpass"); hiss(1.2, 200, 0.6, 0.5, "lowpass", 60, 0.05); break;
      case "glacius": [1568, 2093, 2637, 3136].forEach((f, i) => tone("sine", f, f * 0.98, 0.5, 0.06, i * 0.05)); hiss(0.4, 5000, 2, 0.12); break;
      case "expelliarmus": tone("square", 900, 120, 0.35, 0.07); hiss(0.3, 1500, 1, 0.2); break;
      case "protego": [523, 659, 784, 1047].forEach((f, i) => tone("triangle", f, f, 0.9, 0.07, i * 0.06)); break;
    }
  },
  whoosh() { if (!muted && ctx) hiss(0.25, 800, 0.8, 0.12, "bandpass", 2400); },
  fizzle() { if (!muted && ctx) { hiss(0.5, 400, 1, 0.15, "lowpass", 120); tone("sine", 300, 90, 0.4, 0.05); } },
  hit() { if (!muted && ctx) { tone("sine", 220, 60, 0.3, 0.2); hiss(0.25, 900, 0.8, 0.2); } },
  hurt() { if (!muted && ctx) { tone("sawtooth", 160, 50, 0.6, 0.15); } },
  click() { if (!muted && ctx) tone("sine", 880, 660, 0.08, 0.06); },
};

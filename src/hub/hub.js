// Draws the 21-point hand-tracking skeleton (same topology as MediaPipe)
// and morphs the hero hand between the gestures the games use.

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];
const KNUCKLES = [[-34, -6], [-11, -14], [12, -11], [33, 0]];     // index..pinky
const SPREAD = [-0.13, -0.03, 0.07, 0.19];                       // finger fan (radians)
const SEGS = [[38, 24, 20], [42, 27, 21], [39, 25, 20], [30, 20, 17]];

// curl: 0 = straight, 1 = fully folded. thumb: 0 = out, 1 = across the palm
const POSES = {
  open:  { fingers: [0, 0, 0, 0], thumb: 0, name: "Open palm", use: "casts Lumos and wipes the Air Draw board" },
  point: { fingers: [0, 1, 1, 1], thumb: 0.8, name: "Point", use: "draws a rune in Spell Caster" },
  peace: { fingers: [0, 0, 1, 1], thumb: 0.85, name: "Peace", use: "plays scissors in Rock Paper Scissors" },
  fist:  { fingers: [1, 1, 1, 1], thumb: 1, name: "Fist", use: "charges a burst in Enchanted" },
};

function landmarks({ fingers, thumb }) {
  const p = Array(21);
  p[0] = [0, 92];
  // thumb: base near the wrist, swings from out-left to tucked over the folded fingers
  p[1] = [-24, 78];
  let ang = -2.25 + thumb * 0.95;
  const tl = [30, 24, 19];
  let cur = p[1];
  for (let k = 0; k < 3; k++) {
    cur = [cur[0] + Math.cos(ang) * tl[k], cur[1] + Math.sin(ang) * tl[k]];
    p[2 + k] = cur;
    ang += 0.12 + thumb * 0.3;
  }
  // fingers: seen from the front, a curl folds the segments back down over the palm
  fingers.forEach((c, f) => {
    const base = 5 + f * 4;
    let [x, y] = KNUCKLES[f];
    p[base] = [x, y];
    let bend = 0;
    const dir = SPREAD[f] * (1 - c);
    for (let k = 0; k < 3; k++) {
      bend += c * [1.25, 1.75, 1.2][k];
      const len = SEGS[f][k] * (1 - c * 0.12);
      x += Math.sin(dir) * len * Math.cos(bend) - c * 2.5;
      y -= Math.cos(dir) * len * Math.cos(bend);
      p[base + k + 1] = [x, y];
    }
  });
  return p;
}

const NS = "http://www.w3.org/2000/svg";
function build(svg) {
  const palm = document.createElementNS(NS, "path");
  palm.setAttribute("class", "palm");
  svg.appendChild(palm);
  const lines = CONNECTIONS.map(() => {
    const l = document.createElementNS(NS, "line");
    l.setAttribute("class", "bone");
    svg.appendChild(l);
    return l;
  });
  const dots = Array.from({ length: 21 }, () => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("class", "joint");
    svg.appendChild(c);
    return c;
  });
  return (pts, r = 4.2) => {
    palm.setAttribute("d", `M${[0, 1, 5, 9, 13, 17].map((i) => pts[i].join(" ")).join(" L")} Z`);
    CONNECTIONS.forEach(([a, b], i) => {
      lines[i].setAttribute("x1", pts[a][0]); lines[i].setAttribute("y1", pts[a][1]);
      lines[i].setAttribute("x2", pts[b][0]); lines[i].setAttribute("y2", pts[b][1]);
    });
    dots.forEach((d, i) => {
      d.setAttribute("cx", pts[i][0]); d.setAttribute("cy", pts[i][1]);
      d.setAttribute("r", i % 4 === 0 && i ? r * 1.25 : r);   // fingertips a little bigger
    });
  };
}

// Small static hands in the game list
document.querySelectorAll("svg.mini").forEach((svg) => build(svg)(landmarks(POSES[svg.dataset.pose]), 6));

// Hero: morph through the gestures
const hero = document.getElementById("heroHand");
const draw = build(hero);
const order = ["point", "open", "peace", "fist"];
const nameEl = document.getElementById("gestureName");
const useEl = document.getElementById("gestureUse");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const blend = (A, B, t) => ({
  fingers: A.fingers.map((v, i) => lerp(v, B.fingers[i], t)),
  thumb: lerp(A.thumb, B.thumb, t),
});

let idx = 0;
function show(i) {
  const pose = POSES[order[i]];
  nameEl.textContent = pose.name;
  useEl.textContent = pose.use;
}
draw(landmarks(POSES[order[0]]));
show(0);

if (!reduce) {
  const HOLD = 1800, MORPH = 700;
  let t0 = performance.now();
  const tick = (now) => {
    const t = now - t0;
    if (t > HOLD) {
      const f = Math.min(1, (t - HOLD) / MORPH);
      const next = (idx + 1) % order.length;
      draw(landmarks(blend(POSES[order[idx]], POSES[order[next]], ease(f))));
      if (f >= 1) { idx = next; show(idx); t0 = now; }
    }
    // gentle idle sway so the tracker looks "live"
    hero.style.transform = `rotate(${Math.sin(now / 1400) * 2.5}deg) translateY(${Math.sin(now / 900) * 3}px)`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

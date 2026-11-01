import {
  createHandLandmarker, startCamera, screenMapper, fingerStates, pinchRatio, PoseFilter,
} from "../shared/hands.js";
import { HandMouse } from "../shared/handmouse.js";
import { sfx, unlockAudio } from "../spells/audio.js";

const $ = (id) => document.getElementById(id);
const video = $("video");
const toScreen = screenMapper(video);
const handMouse = new HandMouse();

const MOVES = {
  rock: { emoji: "✊", name: "Rock", beats: "scissors" },
  paper: { emoji: "✋", name: "Paper", beats: "rock" },
  scissors: { emoji: "✌️", name: "Scissors", beats: "paper" },
};
const IDS = Object.keys(MOVES);
const WIN_TARGET = 3; // best of 5

let landmarker = null, cameraOn = false, lastVideoTime = -1;
let live = null;                  // current detected move (stable)
const filter = new PoseFilter(3);
let state = "idle";               // idle | countdown | shoot | reveal | done
let youScore = 0, aiScore = 0, rounds = [];
let lastPlayerMove = null;
let samples = [];

// ---------- Detection ----------
function moveFromHand(lm, world) {
  const f = fingerStates(lm, video.videoWidth, video.videoHeight, world);
  if (f.every((s) => s === "curl")) return "rock";
  if (f.every((s) => s === "ext")) return "paper";
  if (f[0] === "ext" && f[1] === "ext" && f[2] !== "ext" && f[3] !== "ext") return "scissors";
  // a bit more forgiving for paper (fingers slightly bent)
  if (f.filter((s) => s === "ext").length >= 3 && !f.includes("curl")) return "paper";
  return null;
}

function onFrame(res) {
  const lm = res?.landmarks?.[0];
  if (!lm) {
    live = null;
    filter.reset();
    handMouse.hide();
    showLive();
    return;
  }
  const m = moveFromHand(lm, res.worldLandmarks?.[0]);
  live = filter.update(m ?? "none");
  if (live === "none") live = null;
  showLive();
  if (state === "shoot") samples.push(m);

  // Pinch-to-click only between rounds, and never while making a fist (fist ≈ pinch)
  if ((state === "idle" || state === "reveal" || state === "done") && m !== "rock") {
    const t = toScreen(lm[8]), th = toScreen(lm[4]);
    handMouse.update({ x: (t.x + th.x) / 2, y: (t.y + th.y) / 2 }, pinchRatio(lm, video.videoWidth, video.videoHeight));
  } else handMouse.hide();
}

function showLive() {
  if (state === "reveal" || state === "done") return;
  const el = $("youHand");
  el.textContent = live ? MOVES[live].emoji : "·";
  el.classList.toggle("unsure", !live);
  $("youLabel").textContent = live ? MOVES[live].name : cameraOn ? "Show your hand" : "Camera off";
}

function loop(now) {
  if (landmarker && cameraOn && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    onFrame(landmarker.detectForVideo(video, now));
  }
  requestAnimationFrame(loop);
}

// ---------- Game ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function aiPick() {
  // A little "psychology": people often repeat — 35% of the time, counter your last move.
  if (lastPlayerMove && Math.random() < 0.35) return IDS.find((id) => MOVES[id].beats === lastPlayerMove);
  return IDS[Math.floor(Math.random() * 3)];
}

function renderScore() {
  $("youScore").textContent = youScore;
  $("aiScore").textContent = aiScore;
  const pips = $("pips");
  pips.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const p = document.createElement("i");
    if (rounds[i]) p.className = rounds[i];
    pips.appendChild(p);
  }
}

function beat(text) {
  const c = $("count");
  c.textContent = text;
  c.classList.remove("beat");
  void c.offsetWidth;
  c.classList.add("beat");
}

async function playRound() {
  if (state === "countdown" || state === "shoot") return;
  unlockAudio();
  if (state === "done" || state === "idle" && rounds.length === 0) { youScore = 0; aiScore = 0; rounds = []; renderScore(); }
  state = "countdown";
  $("actionBtn").hidden = true;
  $("hint").textContent = "Get ready…";
  $("result").textContent = "";
  $("result").className = "";
  for (const c of ["youCard", "aiCard"]) $(c).classList.remove("win", "lose", "locked");
  $("aiHand").classList.add("shuffle");
  $("aiLabel").textContent = "Thinking…";

  const shuffle = setInterval(() => { $("aiHand").textContent = MOVES[IDS[Math.floor(Math.random() * 3)]].emoji; }, 110);
  for (const w of ["Rock", "Paper", "Scissors"]) { beat(w); sfx.click(); await wait(650); }
  beat("Shoot!");
  sfx.hit();
  state = "shoot";
  samples = [];
  await wait(420);
  clearInterval(shuffle);

  // majority vote over the frames right after "Shoot!"
  const counts = {};
  for (const s of samples) if (s) counts[s] = (counts[s] || 0) + 1;
  const you = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || live;

  state = "reveal";
  $("aiHand").classList.remove("shuffle");
  if (!you) {
    $("aiHand").textContent = "🤖";
    $("aiLabel").textContent = "Waiting…";
    $("result").textContent = "I didn't see your hand!";
    $("hint").textContent = "Keep your hand in view of the camera";
    $("actionBtn").textContent = "Try again";
    $("actionBtn").hidden = false;
    state = "idle";
    return;
  }

  const ai = aiPick();
  lastPlayerMove = you;
  $("youCard").classList.add("locked");
  $("youHand").textContent = MOVES[you].emoji;
  $("youHand").classList.remove("unsure");
  $("youLabel").textContent = MOVES[you].name;
  $("aiHand").textContent = MOVES[ai].emoji;
  $("aiHand").classList.remove("reveal");
  void $("aiHand").offsetWidth;
  $("aiHand").classList.add("reveal");
  $("aiLabel").textContent = MOVES[ai].name;

  let outcome;
  if (you === ai) outcome = "draw";
  else if (MOVES[you].beats === ai) outcome = "you";
  else outcome = "ai";
  rounds.push(outcome);
  if (outcome === "you") youScore++;
  if (outcome === "ai") aiScore++;
  renderScore();

  const R = $("result");
  if (outcome === "you") { R.textContent = `${MOVES[you].name} beats ${MOVES[ai].name.toLowerCase()}!`; R.className = "win"; $("youCard").classList.add("win"); $("aiCard").classList.add("lose"); sfx.cast("protego"); }
  else if (outcome === "ai") { R.textContent = `${MOVES[ai].name} beats ${MOVES[you].name.toLowerCase()}`; R.className = "lose"; $("aiCard").classList.add("win"); $("youCard").classList.add("lose"); sfx.hurt(); }
  else { R.textContent = "Draw!"; sfx.fizzle(); }
  beat(outcome === "you" ? "Win" : outcome === "ai" ? "Lose" : "Draw");

  if (youScore >= WIN_TARGET || aiScore >= WIN_TARGET || rounds.length >= 5) {
    state = "done";
    await wait(900);
    const won = youScore > aiScore;
    beat(youScore === aiScore ? "Tie game" : won ? "You win! 🏆" : "AI wins 🤖");
    $("hint").textContent = `Final score ${youScore} – ${aiScore}`;
    $("actionBtn").textContent = "Play again";
    $("actionBtn").hidden = false;
  } else {
    $("hint").textContent = "Next round starting…";
    await wait(1700);
    if (state === "reveal") playRound();
  }
}

$("actionBtn").onclick = async () => {
  if (!cameraOn) {
    $("hint").textContent = "Opening camera…";
    try {
      await startCamera(video);
      cameraOn = true;
      document.body.classList.add("cam");
    } catch (err) {
      $("hint").textContent = "Camera error: " + err.message;
      return;
    }
    if (!landmarker) {
      $("hint").textContent = "Loading hand tracking…";
      await modelReady;
    }
  }
  playRound();
};

const modelReady = createHandLandmarker()
  .then((l) => (landmarker = l))
  .catch(() => {
    $("hint").textContent = "Couldn't load hand tracking. Check your internet and reload.";
  });
renderScore();
requestAnimationFrame(loop);

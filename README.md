# Handheld

Your hand is the controller.

Browser games you play with your hands. Hand tracking runs fully in the browser
(MediaPipe), so the camera feed never leaves your device.

## Run

```bash
npm install
npm run dev
```

- Computer: open `https://localhost:5173`
- Phone / iPad on the same Wi-Fi: open the **Network** URL that starts with `192.168.…`
  and tap through the certificate warning (Advanced → Proceed / Show Details → visit).

## Games

| Game | Path | Gestures |
| --- | --- | --- |
| **Enchanted** | `/enchanted/` | ✋ sparks orbit your palm · 👋 move to trail sparks · ✊ then ✋ to burst · 🤌 pinch to swirl sparks at your fingertips · two open hands exchange sparks · R records a clip · U hides the sci-fi rings |
| **Spell Caster** | `/spells/` | ☝️ draw runes · ✋ hold for Lumos · ✊ Nox · 🤏 menus |
| **Air Draw** | `/air-draw/` | ☝️ draw · ✋✊✋✊ eraser mode · ✋ swipe to erase · 🤏 click |
| **Rock Paper Scissors** | `/rps/` | ✊ ✋ ✌️ · 🤏 buttons |

### Spell Caster runes

| Rune | Spell | Effect |
| --- | --- | --- |
| ◯ circle | Protego | Golden shield |
| △ triangle | Incendio | Fireball + explosion |
| ⚡ zigzag (top → bottom) | Fulgur | Lightning strike |
| V | Glacius | Ice shards |
| — horizontal line | Expelliarmus | Red beam |

Wraiths drift down carrying runes. Draw the rune shown on them to banish them.
Lightning and ice unlock after 20 seconds. Chain banishes for combos up to ×5.
You can also draw runes with the mouse or a finger on the touchscreen.

## Structure

```
index.html            Handheld home page
air-draw/ spells/ rps/  one page per game
src/shared/hands.js   camera, MediaPipe, pose helpers (shared by all games)
src/shared/handmouse.js  pinch-to-click cursor for menus
src/spells/runes.js   rune shapes + stroke recognizer
src/spells/fx.js      particle / lightning / beam / shield effects
src/spells/audio.js   synthesized sound effects
```

## Deploy (GitHub Pages, automatic)

Every push to `main` builds the site and publishes it with GitHub Actions
(`.github/workflows/deploy.yml`).

One-time setup:
1. Create an empty repo on GitHub (e.g. `handheld`) and push this folder to `main`.
2. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. After the first run (Actions tab), the site is at `https://<username>.github.io/handheld/`.

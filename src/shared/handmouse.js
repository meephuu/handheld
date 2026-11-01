// Pinch-to-click hand cursor for menus. Buttons/links with [data-hand] or <button> are clickable.
const PINCH_DOWN = 0.28, PINCH_UP = 0.42;

export class HandMouse {
  constructor() {
    this.el = document.createElement("div");
    this.el.className = "hm-cursor";
    this.el.innerHTML = '<div class="hm-ring"></div>';
    document.body.appendChild(this.el);
    this.pos = null;
    this.pinching = false;
    this.hover = null;
    const css = document.createElement("style");
    css.textContent = `
      .hm-cursor { position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px;
        pointer-events: none; z-index: 1000; display: none; }
      .hm-cursor.on { display: block; }
      .hm-cursor::after { content: ""; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px;
        margin: -4px 0 0 -4px; border-radius: 50%; background: #fff; box-shadow: 0 0 8px rgba(0,0,0,.6); }
      .hm-ring { position: absolute; inset: 0; border-radius: 50%; border: 2px solid rgba(255,255,255,.7);
        transition: transform .12s, background .12s; }
      .hm-cursor.down .hm-ring { transform: scale(.7); background: rgba(255,255,255,.35); }
      .hm-hover { filter: brightness(1.25); outline: 2px solid rgba(255,255,255,.6); outline-offset: 3px; }`;
    document.head.appendChild(css);
  }

  /** screenPt: cursor position, ratio: pinch ratio. Returns true if a click fired. */
  update(screenPt, ratio) {
    this.pos = this.pos
      ? { x: this.pos.x + (screenPt.x - this.pos.x) * 0.7, y: this.pos.y + (screenPt.y - this.pos.y) * 0.7 }
      : screenPt;
    this.el.classList.add("on");
    this.el.style.transform = `translate(${this.pos.x}px, ${this.pos.y}px)`;

    const was = this.pinching;
    if (!this.pinching && ratio < PINCH_DOWN) this.pinching = true;
    else if (this.pinching && ratio > PINCH_UP) this.pinching = false;
    this.el.classList.toggle("down", this.pinching);

    const target = document.elementFromPoint(this.pos.x, this.pos.y)?.closest("button, a, [data-hand]") || null;
    if (target !== this.hover) {
      this.hover?.classList.remove("hm-hover");
      this.hover = target;
      this.hover?.classList.add("hm-hover");
    }
    if (this.pinching && !was && this.hover) {
      this.hover.click();
      return true;
    }
    return false;
  }

  hide() {
    this.el.classList.remove("on", "down");
    this.hover?.classList.remove("hm-hover");
    this.hover = null;
    this.pos = null;
    this.pinching = false;
  }
}

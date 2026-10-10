// J1 juice HUD: the centre combo banner (DOUBLE KILL … CARRIER DOWN!), the
// style-score popups rising off the reticle, the streak counter, the
// slow-mo vignette and the break-up cam's `cine` mode (aim chrome hidden —
// the camera is not looking down the gun line). Every node is built once
// here and styled in ui/polish.css; a beat replays its animation with a
// class restart, and per-frame calls only touch a node when what it shows
// changes. Text goes in as textContent — nothing here is ever HTML.

/** How long the combo banner holds before it fades, ms. */
const BANNER_MS = 1700;
/** Popups in the pool (oldest reused); each rises for 1.1 s (CSS). */
const POPUPS = 4;

/** A banner's look: combos are gold, the carrier war's moments red-hot. */
export type BannerTone = "combo" | "big" | "moment";

const make = (id: string, parent: HTMLElement): HTMLDivElement => {
  const el = document.createElement("div");
  el.id = id;
  el.setAttribute("aria-hidden", "true");
  parent.appendChild(el);
  return el;
};

/** Restart a CSS animation: the class must be off for a reflow first. */
const replay = (el: HTMLElement, cls: string): void => {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
};

export class JuiceHud {
  private readonly banner: HTMLDivElement;
  private readonly popups: HTMLDivElement[] = [];
  private readonly streakEl: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private nextPopup = 0;
  private bannerUntil = 0;
  private streakShown = -1;
  private dipShown = false;
  private cineShown = false;

  constructor(private readonly body: HTMLElement = document.body) {
    this.vignette = make("juice-vignette", body);
    this.banner = make("juice-combo", body);
    for (let i = 0; i < POPUPS; i++) {
      const el = make(`juice-pop-${i}`, body);
      el.className = "juice-pop";
      this.popups.push(el);
    }
    this.streakEl = make("juice-streak", body);
  }

  /** Pop the centre banner (`tone` sets its colour and size). */
  showBanner(text: string, tone: BannerTone, now: number): void {
    this.banner.textContent = text;
    this.banner.dataset.tone = tone;
    replay(this.banner, "on");
    this.bannerUntil = now + BANNER_MS;
  }

  /** A style-score popup rising off the reticle. */
  popScore(points: number): void {
    const el = this.popups[this.nextPopup] as HTMLDivElement;
    this.nextPopup = (this.nextPopup + 1) % POPUPS;
    el.textContent = `+${Math.round(points)}`;
    // Stagger popups that land together so they never sit on each other.
    el.style.setProperty("--juice-lane", String(this.nextPopup % 2));
    replay(el, "on");
  }

  /** The life's kill streak (shown from 2 up). */
  setStreak(streak: number): void {
    const n = streak >= 2 ? Math.floor(streak) : 0;
    if (n === this.streakShown) return;
    const grew = n > this.streakShown && n > 0;
    this.streakShown = n;
    this.streakEl.textContent = n > 0 ? `STREAK ×${n}` : "";
    this.streakEl.classList.toggle("shown", n > 0);
    if (grew) replay(this.streakEl, "bump");
  }

  /** Per frame: age the banner, the slow-mo vignette and the cine mode. */
  update(now: number, dipping: boolean, cine: boolean): void {
    if (this.bannerUntil !== 0 && now > this.bannerUntil) {
      this.banner.classList.remove("on"); // CSS fades it out
      this.bannerUntil = 0;
    }
    if (dipping !== this.dipShown) {
      this.dipShown = dipping;
      this.vignette.classList.toggle("on", dipping);
    }
    if (cine !== this.cineShown) {
      this.cineShown = cine;
      this.body.classList.toggle("cine", cine);
    }
  }
}

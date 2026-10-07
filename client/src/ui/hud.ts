// Combat HUD: own HP and gun-heat gauges, the spawn-protection badge, the
// kill-cam overlay, and the hit-confirm blip on the crosshair. Pure DOM over
// the chrome in index.html (same split as ui/join.ts) — the values shown are
// whatever the server said, never a client-side simulation of them.

import { MAX_HP } from "@angels-bandits/common/constants";

export class Hud {
  private readonly hpFill = document.getElementById(
    "hp-fill",
  ) as HTMLDivElement;
  private readonly heatEl = document.getElementById("heat") as HTMLDivElement;
  private readonly heatFill = document.getElementById(
    "heat-fill",
  ) as HTMLDivElement;
  private readonly badge = document.getElementById(
    "protected-badge",
  ) as HTMLDivElement;
  private readonly killcam = document.getElementById(
    "killcam",
  ) as HTMLDivElement;
  private readonly crosshair = document.getElementById(
    "crosshair",
  ) as unknown as SVGSVGElement;
  private readonly hitmarker = document.getElementById(
    "hitmarker",
  ) as HTMLDivElement;
  private readonly radioToggle = document.getElementById(
    "radio-toggle",
  ) as HTMLDivElement;
  private readonly aimCursor = document.getElementById(
    "aim-cursor",
  ) as unknown as SVGSVGElement;
  private readonly aimModeToast = document.getElementById(
    "aim-mode-toast",
  ) as HTMLDivElement;
  private hitBlipUntil = 0;
  private aimModeTimer: ReturnType<typeof setTimeout> | undefined;
  private markerUntil = 0;

  /** Server-owned HP (snapshots / damage events). */
  setHp(hp: number): void {
    const frac = Math.min(1, Math.max(0, hp / MAX_HP));
    this.hpFill.style.width = `${(frac * 100).toFixed(1)}%`;
  }

  /** Local heat model state (identical to what the server validates with). */
  setHeat(heat: number, locked: boolean): void {
    this.heatFill.style.width = `${(Math.min(1, heat) * 100).toFixed(1)}%`;
    this.heatEl.classList.toggle("locked", locked);
  }

  setProtected(on: boolean): void {
    this.badge.classList.toggle("on", on);
  }

  /**
   * Radio-voice mute toggle (mutes TTS only — the comms ticker stays on).
   * Guns hold their trigger from a window-level mousedown, so pointer events
   * on the toggle must never bubble — clicking it can't mean "fire".
   */
  bindRadioToggle(initial: boolean, onToggle: (on: boolean) => void): void {
    let on = initial;
    const render = () => {
      this.radioToggle.textContent = on ? "RADIO VOICE ON" : "RADIO VOICE OFF";
      this.radioToggle.classList.toggle("off", !on);
    };
    render();
    // ...except button 2, which is the aim zoom and also listens on window.
    const swallow = (e: MouseEvent) => {
      if (e.button !== 2) e.stopPropagation();
    };
    this.radioToggle.addEventListener("mousedown", swallow);
    this.radioToggle.addEventListener("mouseup", swallow);
    this.radioToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      on = !on;
      render();
      onToggle(on);
    });
  }

  /** Free-look (hold E): show the hint and dim the aim chrome via CSS. */
  setFreeLook(on: boolean): void {
    document.body.classList.toggle("freelook", on);
  }

  /** Aim zoom (hold right-click): brighten the pipper via CSS. */
  setZoom(on: boolean): void {
    document.body.classList.toggle("zoom", on);
  }

  /**
   * Put the pipper — and the hitmarker with it — where the gun line lands on
   * screen. Both used to be pinned at 50%/50%, which pointed ~10 degrees below
   * the actual gun line; the hitmarker follows so it still lands "at the
   * reticle" the way its own design says it does. Null hides them (the gun
   * line is behind the camera, or we are dead).
   */
  setAimPoint(p: { x: number; y: number } | null): void {
    if (!p) {
      this.crosshair.style.display = "none";
      return;
    }
    const t = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    this.crosshair.style.transform = t;
    this.crosshair.style.display = "block";
    this.hitmarker.style.transform = t;
  }

  /**
   * The instructor's aim circle at the (smoothed) cursor, and the converged
   * state it shares with the pipper once the nose has arrived. Null hides it
   * and hands the 3D view its OS cursor back (classic mode, kill-cam).
   */
  setAimCursor(p: { x: number; y: number } | null, converged: boolean): void {
    document.body.classList.toggle("aim-instructor", p !== null);
    this.crosshair.classList.toggle("converged", p !== null && converged);
    if (!p) {
      this.aimCursor.style.display = "none";
      return;
    }
    this.aimCursor.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    this.aimCursor.style.display = "block";
    this.aimCursor.classList.toggle("converged", converged);
  }

  /** Brief toast naming the aim mode M just switched to. */
  showAimMode(mode: "instructor" | "classic"): void {
    this.aimModeToast.textContent =
      mode === "instructor"
        ? "◇ AIM: MOUSE INSTRUCTOR (M) ◇"
        : "◇ AIM: CLASSIC STICK (M) ◇";
    this.aimModeToast.classList.add("on");
    // Re-arm the fade: the class must be off for a frame to transition out.
    clearTimeout(this.aimModeTimer);
    this.aimModeTimer = setTimeout(
      () => this.aimModeToast.classList.remove("on"),
      1200,
    );
  }

  /** Kill-cam overlay: who got you (null = you crashed clean; the storm's
   * bolt names itself — discovery is the design, so no more than that). */
  showKillCam(killerName: string | null, cause?: "storm"): void {
    this.killcam.textContent =
      cause === "storm"
        ? "⚡ STRUCK BY THE STORM"
        : killerName === null
          ? "YOU CRASHED"
          : `ELIMINATED BY ${killerName}`;
    this.killcam.classList.add("open");
  }

  hideKillCam(): void {
    this.killcam.classList.remove("open");
  }

  /** One frame's worth of hit-confirm: flash the crosshair briefly. */
  hitConfirm(now: number): void {
    this.hitBlipUntil = now + 120;
    this.crosshair.classList.add("hit");
  }

  /** Instant X at the reticle the frame the local sweep connects (~120 ms). */
  hitMarker(now: number): void {
    // A kill flourish in flight outranks a plain hit — don't shrink it.
    if (this.hitmarker.classList.contains("kill") && now < this.markerUntil) {
      return;
    }
    this.markerUntil = now + 120;
    this.hitmarker.classList.remove("kill");
    this.hitmarker.classList.add("on");
  }

  /** Kill confirm: the marker grows into a pink X held ~400 ms. */
  killConfirm(now: number): void {
    this.markerUntil = now + 400;
    this.hitmarker.classList.add("kill", "on");
  }

  /** Call every frame to age the hit blip and hitmarker out. */
  update(now: number): void {
    if (this.hitBlipUntil !== 0 && now > this.hitBlipUntil) {
      this.crosshair.classList.remove("hit");
      this.hitBlipUntil = 0;
    }
    if (this.markerUntil !== 0 && now > this.markerUntil) {
      this.hitmarker.classList.remove("on"); // CSS fades the rest of the way
      this.markerUntil = 0;
    }
  }
}

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
  ) as HTMLDivElement;
  private readonly hitmarker = document.getElementById(
    "hitmarker",
  ) as HTMLDivElement;
  private readonly radioToggle = document.getElementById(
    "radio-toggle",
  ) as HTMLDivElement;
  private hitBlipUntil = 0;
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
    this.radioToggle.addEventListener("mousedown", (e) => e.stopPropagation());
    this.radioToggle.addEventListener("mouseup", (e) => e.stopPropagation());
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

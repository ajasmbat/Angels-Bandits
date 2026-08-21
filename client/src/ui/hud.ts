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
  private hitBlipUntil = 0;

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

  /** Kill-cam overlay: who got you (null = you crashed clean). */
  showKillCam(killerName: string | null): void {
    this.killcam.textContent =
      killerName === null ? "YOU CRASHED" : `ELIMINATED BY ${killerName}`;
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

  /** Call every frame to age the hit blip out. */
  update(now: number): void {
    if (this.hitBlipUntil !== 0 && now > this.hitBlipUntil) {
      this.crosshair.classList.remove("hit");
      this.hitBlipUntil = 0;
    }
  }
}

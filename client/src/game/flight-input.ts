// Mouse-aim + keyboard → FlightInput. The cursor's offset from screen center
// commands turn/pitch rates (PLAN.md: plane banks/pitches toward the cursor);
// W/S drive throttle, A/D the roll assist. No pointer lock — the visible
// cursor IS the aim point.

import type { FlightInput } from "@angels-bandits/common/flight";

const DEADZONE = 0.06; // fraction of half-screen the cursor can rest in

export class FlightInputSource {
  private mouseX = 0; // -1..1 of half-viewport, +right
  private mouseY = 0; // -1..1 of half-viewport, +down
  private readonly keys = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener("mousemove", (e: MouseEvent) => {
      const half = Math.min(target.innerWidth, target.innerHeight) / 2;
      this.mouseX = (e.clientX - target.innerWidth / 2) / half;
      this.mouseY = (e.clientY - target.innerHeight / 2) / half;
    });
    target.addEventListener("keydown", (e: KeyboardEvent) =>
      this.keys.add(e.code),
    );
    target.addEventListener("keyup", (e: KeyboardEvent) =>
      this.keys.delete(e.code),
    );
    target.addEventListener("blur", () => this.keys.clear());
  }

  private axis(v: number): number {
    const a = Math.abs(v);
    if (a < DEADZONE) return 0;
    const scaled = (a - DEADZONE) / (1 - DEADZONE);
    return Math.sign(v) * Math.min(1, scaled);
  }

  read(): FlightInput {
    const throttle =
      (this.keys.has("KeyW") ? 1 : 0) + (this.keys.has("KeyS") ? -1 : 0);
    // A rolls left (positive roll = left wing down), D rolls right.
    const roll =
      (this.keys.has("KeyA") ? 1 : 0) + (this.keys.has("KeyD") ? -1 : 0);
    return {
      turn: this.axis(this.mouseX), // cursor right of center → right turn
      pitch: this.axis(-this.mouseY), // cursor above center → pull up
      roll,
      throttle,
    };
  }
}

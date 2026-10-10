// A1: the per-frame audio writes' guard. Every frame re-sent each loop's
// gain / pitch / pan as a setTargetAtTime — an automation event crossing to
// the audio thread — even when the target had not moved. This sends it only
// when the target moved more than `eps` since the last one sent; the
// parameter keeps approaching that last target exactly as before.
// (ambience.ts keeps its own copy of the same rule, per instance.)

const targets = new WeakMap<AudioParam, number>();

/** setTargetAtTime, but only when the target moved more than `eps`. Only
 * for parameters nothing else schedules on (no cancel, no other ramps). */
export function rampTo(
  param: AudioParam,
  value: number,
  now: number,
  tc: number,
  eps = 0.002,
): void {
  const last = targets.get(param);
  if (last !== undefined && Math.abs(last - value) < eps) return;
  targets.set(param, value);
  param.setTargetAtTime(value, now, tc);
}

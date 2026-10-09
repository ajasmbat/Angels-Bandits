// Fake pilots for the `furball` segment (O3): plain ws clients that join the
// harness's room and stream poses + fire, so the page renders a FULL room —
// 11 of these plus the measuring page is ROOM_CAP (12) planes.
//
// Why fake pilots and not bots: server bots fly the whole city on their own
// sim and shoot back, so most of them are out of frame at any moment and the
// measuring plane can be killed mid-window. These fly a fixed weave in the
// street corridor straight ahead of the segment's held viewpoint, so all 11
// are in view for the whole window.
//
// They can never hurt the page: damage only comes from a HIT CLAIM, and
// these send `fire` (tracers on every client) but never `hit`. They never
// crash either — crashes are client-reported and these report none — so the
// room stays at 12 for the whole window; the harness still asserts it.
//
// Their poses are a pure function of wall time since `start`, not of the
// server clock, so the segment is UNPINNED (see UNPINNED_SEGMENTS): judge it
// on a paired --ab delta and on p99/p50, not on its absolute GPU p50.
//
// Only the wire's `join` / `pose` / `fire` shapes are used, all three
// unchanged since long before 86e5982, so the same pilots fly against an
// --ab-ref build too.

import WebSocket from "ws";

/** Matches TICK_UP_HZ (common/src/constants.ts): poses go up at 30 Hz. */
const POSE_HZ = 30;
/** A burst of FIRE_SHOTS every FIRE_EVERY_MS, staggered per pilot. */
const FIRE_EVERY_MS = 2400;
const FIRE_SHOTS = 6;
const FIRE_GAP_MS = 90;

/**
 * The furball's weave: 80–380 m ahead of the view, 42–97 m up (between the
 * street lamps and the roofs).
 */
export const FURBALL_FLIGHT = { near: 80, far: 380, yLo: 42, yHi: 97 };

/**
 * Pilot `i`'s canonical pose at `t` seconds: a weave down the corridor of
 * the street the held view looks along (−Z from `center`), staying inside
 * the street band laterally and inside `flight`'s ahead and height bands
 * (S8: the boss segment's pilots weave at altitude, inside the plane LOD's
 * near band). Ground speed peaks ~65 m/s on the furball's band, inside every
 * server speed cap; the CLAIMED speed is floored at MIN_SPEED (40), since no
 * real plane flies slower and remotes draw their prop and trail from it.
 */
export function pilotPose(i, t, center, flight = FURBALL_FLIGHT) {
  const ph = i * 2.399; // golden angle: no two pilots share a phase
  const w = 0.32 + (i % 4) * 0.03; // rad/s along the street
  const mid = (flight.near + flight.far) / 2;
  const half = (flight.far - flight.near) / 2;
  const span = flight.yHi - flight.yLo;
  const ahead = mid + half * Math.sin(w * t + ph);
  const z = center.z - ahead;
  const x = center.x + 9 * Math.sin(2 * w * t + ph * 1.7);
  const y = flight.yLo + span * (0.5 + 0.5 * Math.sin(0.5 * w * t + ph * 0.6));
  // Velocity (derivative of the above) gives heading and speed.
  const vz = -half * w * Math.cos(w * t + ph);
  const vx = 18 * w * Math.cos(2 * w * t + ph * 1.7);
  const vy = span * 0.5 * 0.5 * w * Math.cos(0.5 * w * t + ph * 0.6);
  const flat = Math.hypot(vx, vz) || 1;
  const yaw = Math.atan2(-vx, -vz);
  const pitch = Math.atan2(vy, flat);
  // Yaw about +Y, then pitch about the plane's own X (same convention as
  // createFlightState: yaw 0 faces −Z).
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  return {
    pos: { x, y, z },
    quat: { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp },
    speed: Math.max(40, Math.hypot(vx, vy, vz)),
  };
}

/**
 * Join `count` pilots to the server at `port`, weaving ahead of `center`.
 * Resolves once every pilot has its welcome; `stop()` closes them all.
 * `flight` (S8) sets the weave's bands and whether they fire: the boss
 * segment's pilots hold their fire, because every tracer is a draw call and
 * their bursts land on the pilots' own wall clock.
 */
export async function startPilots(
  port,
  count,
  center,
  { flight = FURBALL_FLIGHT, fire = true } = {},
) {
  const sockets = [];
  const join = (i) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(
        () => reject(new Error(`pilot ${i} never got a welcome`)),
        30_000,
      );
      ws.on("error", reject);
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "join", name: `FURBALL${i}` })),
      );
      const onMessage = (data) => {
        // Only the welcome matters; once it lands, stop parsing — the rest
        // (15 Hz snapshots x 11 sockets) is drained and dropped unread.
        if (JSON.parse(String(data)).type !== "welcome") return;
        ws.off("message", onMessage);
        ws.on("message", () => {});
        clearTimeout(timer);
        resolve(ws);
      };
      ws.on("message", onMessage);
    });
  for (let i = 0; i < count; i++) sockets.push(await join(i));

  const t0 = performance.now();
  let seq = 0;
  const poseTimer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    sockets.forEach((ws, i) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({ type: "pose", pose: pilotPose(i, t, center, flight) }),
      );
    });
  }, 1000 / POSE_HZ);
  const fireTimers = (fire ? sockets : []).map((ws, i) =>
    setInterval(
      () => {
        for (let k = 0; k < FIRE_SHOTS; k++) {
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "fire", seq: ++seq }));
            }
          }, k * FIRE_GAP_MS);
        }
      },
      FIRE_EVERY_MS + (i % 3) * 170,
    ),
  );

  return {
    count: sockets.length,
    stop() {
      clearInterval(poseTimer);
      for (const t of fireTimers) clearInterval(t);
      for (const ws of sockets) ws.close();
    },
  };
}

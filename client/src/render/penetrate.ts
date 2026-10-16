// P1 penetrating impacts, client half: every impact record the server swept
// (`impact`, common/src/city/penetrate.ts) replayed with the same pure
// sweep against this client's city, on the RENDER clock — the clock the
// wrecks, strikes and collapses are drawn at, so the burst lands as the
// body you watch gets there.
//
//  - A burst per chunk, staggered by its entry time (not all at once): a
//    fireball, sparks, and concrete thrown out ahead along the path — out
//    of the exit hole — through the existing pools (no draw of its own).
//  - The body keeps moving: `bodyOf` answers where a wreck (D4) or a
//    meteor / comet is along its tunnel, decelerating, so their renderers
//    draw it on in with their own meshes; `ploughing` lists the strikes
//    still moving for the missile renderer's fireball draw.
//  - The comet's long glowing tail: ONE instanced additive draw (head-to-
//    tip vertex fade) for every comet in the sky or ploughing through the
//    city. The comet's head is the meteor fireball (missiles.ts).
//
// What breaks still arrives as `chunks` (draw == collide); this module only
// shows HOW it broke. Zero allocation per frame: fixed pools, scratch.

import type { Building } from "@angels-bandits/common/city";
import {
  IMPACT_COMET,
  IMPACT_METEOR,
  type ImpactRecord,
  type SweepResult,
  chunkCentre,
  sweepPosAt,
  sweepRecord,
  sweepSpeedAt,
} from "@angels-bandits/common/city/penetrate";
import { EMISSIVE_BEACON } from "@angels-bandits/common/constants";
import {
  type MissileStrike,
  missileImpactAt,
  missilePosAt,
} from "@angels-bandits/common/strike";
import { type Vec3, wrapDeltaInto } from "@angels-bandits/common/world";
import * as THREE from "three";
import { emissiveBoost } from "./emissive";
import type { Explosions, Sparks } from "./fx";
import type { Impacts } from "./impacts";
import { nearestImageInto } from "./wrapPlacement";

/** Sweeps replayed at once (the oldest is dropped past it). */
export const PENETRATIONS_MAX = 24;
/** A finished sweep is kept this long after it stopped, s (a late body
 * query still finds where it rests). */
const LINGER_S = 2;
/** Bodies still moving at once (the missile renderer's extra fireballs). */
export const PLOUGH_POOL = 8;
/** Comet tails drawn at once. */
export const COMET_POOL = 6;
/** The tail: length behind the head at full speed, m, and its root radius. */
const COMET_TAIL_M = 170;
const COMET_TAIL_R = 7;
/** Hot blue-white: a different rung from the meteor's orange, never the
 * storm's violet. */
const COMET_COLOR = new THREE.Color(0xbfe4ff);
/** Each chunk's burst: explosion size by kind (plane … section). */
const BURST_SIZE = [0.8, 0.9, 1.1, 1.1, 1.6, 0.7] as const;

interface Active {
  rec: ImpactRecord;
  res: SweepResult;
  /** The next chunk whose burst has not played. */
  next: number;
  /** The rest burst has played. */
  rested: boolean;
}

/** A strike still moving through the city this frame. */
export interface PloughBody {
  kind: number;
  src: number;
  pos: Vec3;
  dir: Vec3;
  speed: number;
}

/** bodyOf: no sweep known for that source / moving / at rest. */
export const BODY_NONE = 0;
export const BODY_MOVING = 1;
export const BODY_RESTING = 2;

/** One cone geometry, the tail: root at the origin, tip along +Z; vertex
 * colour 1 at the root fading to 0 at the tip (additive: the tip is air). */
function tailGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(1, 1, 10, 6, true);
  // Cone: apex at +y/2. Lay it along +Z with the apex (tip) at z = 1.
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, 0.5);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const f = (1 - Math.min(1, Math.max(0, pos.getZ(i)))) ** 1.6;
    col[i * 3] = f;
    col[i * 3 + 1] = f;
    col[i * 3 + 2] = f;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

export class Penetrations {
  readonly group = new THREE.Group();
  private readonly active: Active[] = [];
  /** Strikes still ploughing this frame: the first `ploughCount` of it. */
  readonly ploughing: PloughBody[] = [];
  ploughCount = 0;
  private readonly tails: THREE.InstancedMesh;
  private share = 1;
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly exit: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly img: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly dir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly ahead: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v3 = new THREE.Vector3();
  private readonly s3 = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  /** QA (__ab.qaPenetrate / perf): what the last frame did. */
  readonly stats = { sweeps: 0, bursts: 0, tails: 0, ploughing: 0 };

  constructor(
    private readonly buildings: readonly Building[],
    private readonly explosions: Explosions,
    private readonly sparks: Sparks,
    private readonly impacts: Impacts,
    /** A chunk burst (first: the wall it came in through; last: the rest)
     * — audio and shake hang off it. */
    private readonly onBurst?: (
      at: Vec3,
      rec: ImpactRecord,
      first: boolean,
    ) => void,
  ) {
    for (let i = 0; i < PLOUGH_POOL; i++) {
      this.ploughing.push({
        kind: 0,
        src: 0,
        pos: { x: 0, y: 0, z: 0 },
        dir: { x: 0, y: 0, z: 1 },
        speed: 0,
      });
    }
    const core = COMET_COLOR.clone().multiplyScalar(
      emissiveBoost(COMET_COLOR, EMISSIVE_BEACON),
    );
    this.tails = new THREE.InstancedMesh(
      tailGeometry(),
      new THREE.MeshBasicMaterial({
        color: core,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        // The comet's telegraph, like the meteor's glint: seen city-wide.
        fog: false,
      }),
      COMET_POOL,
    );
    this.tails.count = 0;
    this.tails.visible = false;
    this.tails.frustumCulled = false;
    this.group.add(this.tails);
  }

  /** Quality row: the share of each burst's debris throw. */
  setQuality(share: number): void {
    this.share = Math.max(0, Math.min(1, share));
  }

  /** A welcome / reconnect: nothing in flight any more. */
  reset(): void {
    this.active.length = 0;
    this.ploughCount = 0;
  }

  /** The server swept `rec`: replay it against this client's city as it
   * stands (the server sends it before the chunks it breaks). */
  add(rec: ImpactRecord): SweepResult {
    const res = sweepRecord(rec, this.buildings);
    if (this.active.length >= PENETRATIONS_MAX) this.active.shift();
    this.active.push({ rec, res, next: 0, rested: false });
    return res;
  }

  /**
   * Where source `src` of `kind` is at render time `ms` along its tunnel
   * (`pos`, and its unit heading in `dir`): BODY_MOVING, BODY_RESTING
   * (`pos` = where it came to rest) or BODY_NONE (no sweep known — the
   * caller lands it where it hit, as before P1).
   */
  bodyOf(kind: number, src: number, ms: number, pos: Vec3, dir: Vec3): number {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i] as Active;
      if (a.rec.kind !== kind || a.rec.src !== src) continue;
      const s = (ms - a.rec.t) / 1000;
      sweepPosAt(a.res, s, pos);
      dir.x = a.res.dir.x;
      dir.y = a.res.dir.y;
      dir.z = a.res.dir.z;
      return s < a.res.stopT ? BODY_MOVING : BODY_RESTING;
    }
    return BODY_NONE;
  }

  /**
   * Per frame on the render clock `ms` (`now`: the frame clock): play the
   * bursts whose chunk the body has reached, list the strikes still
   * ploughing, and place the comet tails — `flying` (the strikes in the
   * air, comets among them) and the comets ploughing on.
   */
  update(
    viewer: Vec3,
    ms: number | null,
    now: number,
    flying: readonly MissileStrike[],
  ): void {
    this.ploughCount = 0;
    let bursts = 0;
    let tails = 0;
    if (ms !== null) {
      let kept = 0;
      for (let i = 0; i < this.active.length; i++) {
        const a = this.active[i] as Active;
        const s = (ms - a.rec.t) / 1000;
        bursts += this.burst(a, s, now);
        if (s < a.res.stopT && s >= 0) {
          this.plough(a, s);
          if (a.rec.kind === IMPACT_COMET) {
            const k = sweepSpeedAt(a.res, s) / Math.max(1, a.res.speed);
            sweepPosAt(a.res, s, this.at);
            tails = this.tail(tails, viewer, this.at, a.res.dir, k);
          }
        }
        if (s < a.res.stopT + LINGER_S) this.active[kept++] = a;
      }
      this.active.length = kept;
      for (let f = 0; f < flying.length; f++) {
        const m = flying[f] as MissileStrike;
        if (m.kind !== "comet" || ms >= missileImpactAt(m)) continue;
        missilePosAt(m, ms, this.at);
        missilePosAt(m, ms + 40, this.ahead);
        wrapDeltaInto(this.at, this.ahead, this.dir);
        const len = Math.hypot(this.dir.x, this.dir.y, this.dir.z) || 1;
        this.dir.x /= len;
        this.dir.y /= len;
        this.dir.z /= len;
        tails = this.tail(tails, viewer, this.at, this.dir, 1);
      }
    }
    this.tails.count = tails;
    this.tails.visible = tails > 0;
    if (tails > 0) this.tails.instanceMatrix.needsUpdate = true;
    this.stats.sweeps = this.active.length;
    this.stats.bursts = bursts;
    this.stats.tails = tails;
    this.stats.ploughing = this.ploughCount;
  }

  /** Bursts due by `s` seconds into sweep `a`; returns how many played. */
  private burst(a: Active, s: number, now: number): number {
    const { res, rec } = a;
    let n = 0;
    const size = BURST_SIZE[rec.kind] ?? 1;
    while (a.next < res.chunks.length && (res.times[a.next] as number) <= s) {
      const k = a.next++;
      const id = res.chunks[k] as number;
      if (!chunkCentre(this.buildings, id, this.at)) continue;
      // Out of the exit side: the far face of the chunk along the path.
      this.exit.x = this.at.x + res.dir.x * 6;
      this.exit.y = Math.max(0.5, this.at.y + res.dir.y * 6);
      this.exit.z = this.at.z + res.dir.z * 6;
      this.explosions.explode(this.at, now, size);
      this.sparks.burst(this.exit, now);
      if (this.share > 0) {
        this.impacts.missileDebris(this.exit, res.dir, this.share, now);
      }
      this.onBurst?.(this.at, rec, k === 0);
      n++;
    }
    if (!a.rested && s >= res.stopT && res.contact >= 0) {
      a.rested = true;
      this.explosions.explode(res.stop, now, size * 0.8);
      this.sparks.burst(res.stop, now);
      this.onBurst?.(res.stop, rec, false);
      n++;
    }
    return n;
  }

  /** List a meteor or comet still moving through the city. */
  private plough(a: Active, s: number): void {
    const kind = a.rec.kind;
    if (kind !== IMPACT_METEOR && kind !== IMPACT_COMET) return;
    if (this.ploughCount >= PLOUGH_POOL) return;
    const b = this.ploughing[this.ploughCount++] as PloughBody;
    b.kind = kind;
    b.src = a.rec.src;
    sweepPosAt(a.res, s, b.pos);
    b.dir.x = a.res.dir.x;
    b.dir.y = a.res.dir.y;
    b.dir.z = a.res.dir.z;
    b.speed = sweepSpeedAt(a.res, s);
  }

  /** Comet tail `i` at `pos` heading `dir` (unit), `k` of its full length;
   * returns the next free instance. */
  private tail(
    i: number,
    viewer: Vec3,
    pos: Vec3,
    dir: Vec3,
    k: number,
  ): number {
    if (i >= COMET_POOL || k <= 0.02) return i;
    const p = nearestImageInto(this.img, viewer, pos);
    this.back.set(-dir.x, -dir.y, -dir.z);
    this.q.setFromUnitVectors(Z_AXIS, this.back);
    const r = COMET_TAIL_R * (0.6 + 0.4 * k);
    this.s3.set(r, r, COMET_TAIL_M * k);
    this.m4.compose(this.v3.set(p.x, p.y, p.z), this.q, this.s3);
    this.tails.setMatrixAt(i, this.m4);
    return i + 1;
  }
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);

// D9 street scars and destruction FX. ONE instanced decal mesh for the
// marks blasts leave on the street — craters, the scorch under every burnt
// wreck and station, the wet patch round a burst water main — and the
// effects of the props going down, all through the existing pools (the D1
// particle pool, the explosion shells, the spark bursts: no new draws):
// fireballs when a car, a tanker or a gas station blows (the server's blast
// instant, never a prediction), wrecks burning on, water mains spraying,
// live wires sparking, a felled water tank bursting, a bridge span's splash,
// a jumbotron's crash, and the glittering cascade of a glass curtain wall
// when its chunks break.
//
// All cosmetic: nothing here collides. Every scar is a pure function of
// replicated state (the socket's craters and props), so a late joiner sees
// the same street; craters and wrecks go when the server repairs them.

import {
  type Building,
  chunkBuilding,
  chunkCell,
  chunkTier,
  mulberry32,
  tierGrids,
} from "@angels-bandits/common/city";
import {
  type Crater,
  PROP_BLAST,
  PROP_BRIDGE,
  PROP_FUEL,
  PROP_JUMBO,
  PROP_LAMP,
  PROP_POLE,
  PROP_SIGNAL,
  PROP_STATION,
  PROP_TANK,
  type Prop,
  type PropSlot,
  fallSeconds,
  fallerLanding,
  isExplosive,
} from "@angels-bandits/common/city/props";
import { RIVER_WATER_Y } from "@angels-bandits/common/city/river";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import type { PropsEvent } from "../net/socket";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import type { Explosions, Sparks } from "./fx";
import { type Impacts, Kind } from "./impacts";

/** Decals held at once (craters + scorch + wet patches). */
export const SCARS_MAX = 160;
/** Emitters (sprays, wreck fires, sparking wires) run within this, m. */
export const SCAR_FX_M = 450;
/** At most this many wrecks burn (the nearest), and for this long, ms. */
const WRECK_FIRES = 6;
const WRECK_BURN_MS = 40_000;
/** Live wires spark for this long after their pole falls, ms. */
const WIRE_SPARK_MS = 25_000;
/** Water mains spray this many particles a second (× share). */
const SPRAY_RATE = 70;
/** Glass cascades per `chunks` batch, at most (the rest are quiet). */
const GLASS_CHUNKS_MAX = 14;

/** Linear colours under the tracer rung (impacts.ts' own ladder). */
const GLASS_RGB = [0.72, 0.88, 1.0] as const;
const WATER_RGB = [0.5, 0.66, 0.82] as const;
const MIST_RGB = [0.62, 0.68, 0.74] as const;
const FIRE_RGB = [1.0, 0.52, 0.16] as const;
const SPARK_RGB = [1.0, 0.76, 0.42] as const;
const DUST_RGB = [0.42, 0.4, 0.37] as const;

const UP: Vec3 = { x: 0, y: 1, z: 0 };

/** Soft, ragged dark disc: a blast's crater and scorch (white = the tint). */
function craterTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(size, size);
  const rand = mulberry32(0x5ca75);
  // A fixed ragged rim: 32 radial wobbles.
  const wob = Array.from({ length: 32 }, () => 0.78 + 0.22 * rand());
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      const a = Math.atan2(dy, dx);
      const k = ((a / (Math.PI * 2) + 1) * 32) % 32;
      const i = Math.floor(k);
      const f = k - i;
      const edge =
        (wob[i] as number) * (1 - f) + (wob[(i + 1) % 32] as number) * f;
      const u = r / edge;
      // Dense core, a darker rim of thrown soot, a soft fade out.
      const alpha =
        u < 0.55 ? 0.92 : u < 0.75 ? 0.98 : u < 1 ? 0.98 * (1 - u) * 4 : 0;
      const o = (y * size + x) * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

/** Decal tints (sRGB): a crater's charred pit, a wreck's scorch, the dark
 * wet sheen round a burst main. */
const TINT = { crater: 0x0c0b0a, scorch: 0x060606, wet: 0x16222c } as const;

export class ScarsRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly n: Vec3 = { x: 0, y: 1, z: 0 };
  private share = 1;
  private lastMs = Number.NaN;
  private key = "";
  /** Fractional emission carried frame to frame (typed: no boxing). */
  private readonly acc = new Float64Array(4);
  /** Fallers whose landing burst has been shown (id → downAt). */
  private readonly landed = new Map<number, number>();
  private readonly rand = mulberry32(0xd9);
  private decals = 0;

  constructor(
    private readonly slot: PropSlot,
    private readonly craters: ReadonlyMap<number, Crater>,
    private readonly buildings: readonly Building[],
    private readonly impacts: Impacts,
    private readonly explosions: Explosions,
    private readonly sparks: Sparks,
  ) {
    const disc = new THREE.CircleGeometry(1, 24);
    disc.rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(
      disc,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        map: craterTexture(),
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
      }),
      SCARS_MAX,
    );
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    // One parked instance so the boot pre-warm compiles the program.
    this.m.makeTranslation(0, -9999, 0);
    this.mesh.setMatrixAt(0, this.m);
    this.mesh.setColorAt(0, this.c.setHex(TINT.crater));
    this.mesh.count = 1;
  }

  /** Quality row (chaosFx): share of the sprays, fires and sparks. */
  setShare(share: number): void {
    this.share = share;
  }

  get decalCount(): number {
    return this.decals;
  }

  // --- Events -------------------------------------------------------------

  /** A live `props` batch: fireballs for the blasts that landed, sparks off
   * the lamps, masts and poles that went down. */
  onProps(e: PropsEvent, viewer: Vec3, now: number): void {
    const layout = this.slot.layout;
    for (const b of e.blasts) {
      const p = layout.props[b.id];
      if (!p || !this.near(p, viewer, 900)) continue;
      this.blast(p, now);
    }
    for (const d of e.down) {
      const p = layout.props[d.id];
      if (!p || !this.near(p, viewer, SCAR_FX_M)) continue;
      if (p.kind === PROP_LAMP || p.kind === PROP_SIGNAL || p.kind === PROP_POLE) {
        this.at.x = p.x;
        this.at.y = p.y + p.hy;
        this.at.z = p.z;
        this.sparks.burst(this.at, now);
        this.impacts.spray(Kind.SPARK, this.at, UP, 6, 1.2, 14, 700, 0.35, SPARK_RGB, now);
      }
    }
  }

  /** One prop's blast: shells, a fire column, debris (its D2 damage and
   * any crater arrive on their own). */
  private blast(p: Prop, now: number): void {
    const big = p.kind === PROP_FUEL || p.kind === PROP_STATION;
    this.at.x = p.x;
    this.at.y = p.y + 1;
    this.at.z = p.z;
    this.explosions.explode(this.at, now);
    if (big) {
      const r = (PROP_BLAST[p.kind] as readonly [number, number])[0] * 0.25;
      for (let k = 0; k < 2; k++) {
        this.at.x = p.x + (this.rand() - 0.5) * r;
        this.at.y = p.y + 3 + 4 * this.rand();
        this.at.z = p.z + (this.rand() - 0.5) * r;
        this.explosions.explode(this.at, now);
      }
      this.at.x = p.x;
      this.at.y = p.y + 1;
      this.at.z = p.z;
      this.impacts.spray(Kind.FIRE, this.at, UP, 14, 0.5, 90, 1600, 4.5, FIRE_RGB, now);
    }
    this.impacts.spray(Kind.FIRE, this.at, UP, 7, 1, big ? 40 : 22, 900, 2.6, FIRE_RGB, now);
    this.impacts.spray(Kind.CHIP, this.at, UP, 11, 1.2, big ? 40 : 16, 1800, 0.4, DUST_RGB, now);
    this.impacts.spray(Kind.GLASS, this.at, UP, 8, 1.3, big ? 30 : 12, 1600, 0.35, GLASS_RGB, now);
  }

  /** A `chunks` batch broke `ids`: every chunk of a GLASS curtain wall that
   * sits on an outer face throws a glittering cascade down the facade. */
  glassCascade(ids: readonly number[], viewer: Vec3, now: number): number {
    let shown = 0;
    for (const id of ids) {
      if (shown >= GLASS_CHUNKS_MAX) break;
      if (this.chunkFace(id) && this.nearPoint(this.at, viewer, SCAR_FX_M)) {
        this.impacts.spray(Kind.GLASS, this.at, this.n, 4, 0.9, 44, 2800, 0.75, GLASS_RGB, now);
        this.impacts.spray(Kind.GLASS, this.at, UP, 1.5, 1.4, 12, 3400, 0.45, GLASS_RGB, now);
        shown++;
      }
    }
    return shown;
  }

  /** If chunk `id` is on an outer face of a GLASS building: its face centre
   * into `this.at` and the face normal into `this.n`. */
  private chunkFace(id: number): boolean {
    const b = this.buildings[chunkBuilding(id)];
    if (!b || archetypeFor(b) !== FacadeArchetype.GLASS) return false;
    const g = tierGrids(b)[chunkTier(id)];
    if (!g) return false;
    const cell = chunkCell(id);
    const ix = cell % g.nx;
    const iz = Math.floor(cell / g.nx) % g.nz;
    const iy = Math.floor(cell / (g.nx * g.nz));
    let nx = 0;
    let nz = 0;
    if (ix === 0) nx = -1;
    else if (ix === g.nx - 1) nx = 1;
    else if (iz === 0) nz = -1;
    else if (iz === g.nz - 1) nz = 1;
    else return false;
    const lx = -g.width / 2 + (ix + 0.5) * g.cw + nx * g.cw * 0.5;
    const lz = -g.depth / 2 + (iz + 0.5) * g.cd + nz * g.cd * 0.5;
    this.at.x = b.x + lx;
    this.at.y = g.baseY + (iy + 0.5) * g.ch;
    this.at.z = b.z + lz;
    this.n.x = nx;
    this.n.y = 0;
    this.n.z = nz;
    return true;
  }

  private near(p: Prop, viewer: Vec3, r: number): boolean {
    const dx = wrapDeltaAxis(viewer.x, p.x);
    const dz = wrapDeltaAxis(viewer.z, p.z);
    return dx * dx + dz * dz <= r * r;
  }

  private nearPoint(at: Vec3, viewer: Vec3, r: number): boolean {
    const dx = wrapDeltaAxis(viewer.x, at.x);
    const dz = wrapDeltaAxis(viewer.z, at.z);
    return dx * dx + dz * dz <= r * r;
  }

  // --- Per frame ------------------------------------------------------------

  /** Place the decals and run the emitters for server time `tMs` (null:
   * no clock — decals only) on the real frame time `now`. */
  update(viewer: Vec3, tMs: number | null, now: number): void {
    const dt = Number.isNaN(this.lastMs)
      ? 0
      : Math.min(0.25, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    this.placeDecals(viewer);
    if (tMs === null || dt === 0) return;
    const state = this.slot.state;
    const layout = this.slot.layout;
    // Water mains: a column and its mist, for every burst main near.
    let sprays = 0;
    for (const c of this.craters.values()) {
      if (!c.water) continue;
      this.at.x = c.x;
      this.at.y = 0.3;
      this.at.z = c.z;
      if (!this.nearPoint(this.at, viewer, SCAR_FX_M) || sprays >= 4) continue;
      sprays++;
      // (spray() scales by the pool's own tier share, at least one each —
      // so only a whole particle owed is handed over.)
      const n = this.emit(0, SPRAY_RATE * dt);
      if (n === 0) continue;
      this.impacts.spray(Kind.GLASS, this.at, UP, 12, 0.18, n, 1500, 0.55, WATER_RGB, now);
      if (n >= 4) {
        this.impacts.spray(Kind.DUST, this.at, UP, 2, 0.8, Math.floor(n / 4), 2200, 2.2, MIST_RGB, now);
      }
    }
    // Burning wrecks (the nearest few), and live wires off fallen poles.
    let fires = 0;
    for (const id of state.downIds()) {
      const p = layout.props[id] as Prop;
      if (isExplosive(p.kind)) {
        const te = state.blastAt(id);
        if (Number.isNaN(te) || tMs - te > WRECK_BURN_MS || fires >= WRECK_FIRES) {
          continue;
        }
        if (!this.near(p, viewer, SCAR_FX_M)) continue;
        fires++;
        const fade = 1 - (tMs - te) / WRECK_BURN_MS;
        const big = p.kind === PROP_FUEL || p.kind === PROP_STATION;
        const f = this.emit(1, (big ? 30 : 14) * fade * dt * this.share);
        const sm = this.emit(2, (big ? 9 : 4) * dt * this.share);
        this.at.x = p.x;
        this.at.y = p.y + 0.6;
        this.at.z = p.z;
        this.impacts.wreckFire(this.at, f, sm, big ? 4 : 1.4, now);
      } else if (p.kind === PROP_POLE) {
        const since = tMs - state.downAt(id);
        if (since > WIRE_SPARK_MS || !this.near(p, viewer, SCAR_FX_M)) continue;
        if (this.rand() < dt * 1.6) {
          this.at.x = p.x + (this.rand() - 0.5) * 2;
          this.at.y = 0.5;
          this.at.z = p.z + (this.rand() - 0.5) * 2;
          this.sparks.burst(this.at, now);
          this.impacts.spray(Kind.SPARK, this.at, UP, 5, 1.4, 10, 600, 0.3, SPARK_RGB, now);
        }
      }
    }
    // Fallers landing: a tank bursts, a span hits the water, a jumbotron
    // smashes into the street — shown once, live only.
    for (const id of state.fallers) {
      const p = layout.props[id] as Prop;
      const downAt = state.downAt(id);
      if (this.landed.get(id) === downAt) continue;
      const land = downAt + fallSeconds(p) * 1000;
      if (tMs < land) continue;
      this.landed.set(id, downAt);
      if (tMs - land > 1500 || !this.near(p, viewer, 900)) continue;
      this.landing(id, p, now);
    }
    if (this.landed.size > 64) {
      for (const id of [...this.landed.keys()]) {
        if (!state.isDown(id)) this.landed.delete(id);
      }
    }
  }

  private landing(id: number, p: Prop, now: number): void {
    const at = fallerLanding(this.slot.layout, id);
    this.at.x = at.x;
    this.at.z = at.z;
    if (p.kind === PROP_BRIDGE) {
      this.at.y = RIVER_WATER_Y + 0.5;
      this.impacts.spray(Kind.GLASS, this.at, UP, 16, 0.9, 120, 2400, 0.9, WATER_RGB, now);
      this.impacts.spray(Kind.DUST, this.at, UP, 4, 1.2, 50, 3600, 5, MIST_RGB, now);
      return;
    }
    this.at.y = at.y + 0.5;
    if (p.kind === PROP_TANK) {
      // The tank bursts: a sheet of water over the roof edge.
      this.impacts.spray(Kind.GLASS, this.at, UP, 9, 1.3, 90, 2000, 0.7, WATER_RGB, now);
      this.impacts.spray(Kind.DUST, this.at, UP, 2, 1.2, 30, 2600, 3, MIST_RGB, now);
      return;
    }
    if (p.kind === PROP_JUMBO) {
      this.impacts.spray(Kind.GLASS, this.at, UP, 9, 1.4, 60, 2200, 0.4, GLASS_RGB, now);
      this.sparks.burst(this.at, now);
    }
    this.impacts.spray(Kind.DUST, this.at, UP, 3, 1.3, 30, 3000, 3.5, DUST_RGB, now);
    this.impacts.spray(Kind.SPARK, this.at, UP, 7, 1.3, 20, 700, 0.35, SPARK_RGB, now);
  }

  /** Whole particles owed by emitter `k` this frame (fraction carried). */
  private emit(k: number, owed: number): number {
    const v = (this.acc[k] as number) + owed;
    const n = Math.floor(v);
    this.acc[k] = v - n;
    return n;
  }

  /** Re-pack the decals when the craters, the props or the camera's block
   * change. */
  private placeDecals(viewer: Vec3): void {
    const bx = Math.floor(viewer.x / 200);
    const bz = Math.floor(viewer.z / 200);
    const key = `${bx},${bz},${this.slot.state.version},${this.craters.size},${[...this.craters.keys()].at(-1) ?? 0}`;
    if (key === this.key) return;
    this.key = key;
    let n = 0;
    const put = (x: number, z: number, r: number, hex: number, yaw: number) => {
      if (n >= SCARS_MAX) return;
      this.p.set(viewer.x + wrapDeltaAxis(viewer.x, x), 0.04 + n * 0.0005, viewer.z + wrapDeltaAxis(viewer.z, z));
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      this.s.set(r, 1, r);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, this.c.setHex(hex));
      n++;
    };
    for (const c of this.craters.values()) {
      const yaw = (c.id * 2.399) % (Math.PI * 2);
      if (c.water) put(c.x, c.z, c.r * 2.2, TINT.wet, yaw);
      put(c.x, c.z, c.r, TINT.crater, yaw);
    }
    const state = this.slot.state;
    const layout = this.slot.layout;
    for (const id of state.downIds()) {
      const p = layout.props[id] as Prop;
      const blast = PROP_BLAST[p.kind];
      if (!blast || Number.isNaN(state.blastAt(id))) continue;
      put(p.x, p.z, blast[0] * 0.38, TINT.scorch, p.seed * 6.28);
    }
    this.decals = n;
    if (n === 0) {
      this.m.makeTranslation(0, -9999, 0);
      this.mesh.setMatrixAt(0, this.m);
    }
    this.mesh.count = Math.max(1, n);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

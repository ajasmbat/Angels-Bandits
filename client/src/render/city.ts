// Chunked city renderer. Tiles are aligned to BLOCK_PITCH per the plan — and
// since generateCity() places exactly one building per block, a tile IS one
// building. The whole city stays a single InstancedMesh (1 draw call), now
// with one instance per SOLID (V2 setback tiers, plus H1 hole walls/lintels/
// sills); each frame every instance is placed at its torus image nearest the
// camera, which is what makes the seam invisible. Only the instances whose
// torus image actually flipped are rewritten and uploaded (O2) — a building's
// image changes only as the camera crosses the half-world line from it.
//
// D2: a building destruction has reached is hidden in that mesh and drawn
// instead from its LIVE solids() — the same boxes collision tests — by one
// child InstancedMesh with the same material (so the same program). Each
// damaged building owns a slot range there, rewritten only when its damage
// version or its torus image changes.
//
// D3: collapse debris is a third InstancedMesh, again a child with the same
// material: a falling chunk keeps the facade it fell from (the hand-off from
// the damaged mesh is seamless) and paints as broken concrete once it lands.
// Each collapse owns a slot range, posed every frame by the shared
// piecePose while anything in it moves — the pose the crash check collides
// with — and left alone once it is all rubble (until its image flips).

import {
  type Building,
  CUT_RUBBLE,
  type CityDamage,
  type HoleSpan,
  type SolidBox,
  baseSolids,
  chunkMask,
  cityHoles,
  generateCity,
  solids,
} from "@angels-bandits/common/city";
import {
  type Collapse,
  type CollapseField,
  blankPose,
  piecePose,
} from "@angels-bandits/common/city/collapse";
import {
  type CityIndex,
  buildCityIndex,
} from "@angels-bandits/common/collision";
import {
  COLLAPSE_CAP,
  LANDMARK_HEIGHT,
  WORLD_SIZE,
} from "@angels-bandits/common/constants";
import { type Vec3, wrapDeltaAxis } from "@angels-bandits/common/world";
import * as THREE from "three";
import { FacadeArchetype, archetypeFor } from "./archetypes";
import { BROKEN_DETAIL_UNIFORM } from "./broken-shading";
import { createBuildingsMaterial } from "./buildings-material";
import {
  DamageTexture,
  FacadeDamage,
  faceSlotsFor,
  tierKey,
} from "./damage-map";
import { pieceMatrix } from "./debris";
import {
  type CrewSlot,
  LIVE_ON_UNIFORM,
  LiveClock,
  crewSchedule,
} from "./living-windows";
import { QUALITY_PROFILES, type QualityTier } from "./quality";
import { type RoofStyle, roofStyleFor } from "./roofs";
import { WIN_INTERIOR_UNIFORM, packRun } from "./window-pattern";
import { ImageCache, InstanceUploads, imageIndex } from "./wrapPlacement";

/**
 * VO2 "Neon Blue Hour" facade albedo — real building materials instead of
 * C3's near-black desaturated slabs. Each archetype is a FAMILY of finishes
 * (glass: teal / steel-blue / bronze; masonry: terracotta / red brick /
 * sandstone; office: limestone / warm concrete / cool grey), picked and
 * varied deterministically from the building's own dimensions (shared by
 * all its tiers, seam-safe — never its translation), so a dense block reads
 * as many neighbouring buildings. Albedo only: the lights and the window
 * emissive do the rest, and the brightest finish stays far under the bloom
 * threshold once lit (client/test/facade-palette.test.ts). setHSL is in
 * three's LINEAR working space, so `l` here is (roughly) linear albedo: the
 * pale finishes are pulled to ~0.25 so they don't read as daylit concrete
 * next to the windows.
 */
export function facadeColor(
  b: Pick<Building, "width" | "depth" | "height">,
  arch: number,
  out = new THREE.Color(),
): THREE.Color {
  const t = ((b.height * 7 + b.width * 3 + b.depth) % 17) / 17;
  const v = ((b.width * 13 + b.depth * 7 + b.height * 3) % 23) / 23;
  if (b.height >= LANDMARK_HEIGHT) {
    return out.setHSL(0.52, 0.42, 0.22); // landmark teal — orientation
  }
  if (arch === FacadeArchetype.GLASS) {
    if (v < 0.22) return out.setHSL(0.09 + t * 0.03, 0.34, 0.156 + t * 0.047); // bronze
    if (v < 0.6) return out.setHSL(0.5 + t * 0.04, 0.32, 0.14 + t * 0.055); // teal
    return out.setHSL(0.58 + t * 0.05, 0.3, 0.156 + t * 0.055); // steel blue
  }
  if (arch === FacadeArchetype.MASONRY) {
    if (v < 0.4) return out.setHSL(0.03 + t * 0.02, 0.46, 0.172 + t * 0.047); // terracotta
    if (v < 0.75) return out.setHSL(0.0 + t * 0.02, 0.4, 0.14 + t * 0.039); // red brick
    return out.setHSL(0.08 + t * 0.03, 0.36, 0.19 + t * 0.04); // sandstone
  }
  if (v < 0.45) return out.setHSL(0.1 + t * 0.03, 0.16, 0.185 + t * 0.04); // limestone
  if (v < 0.8) return out.setHSL(0.07 + t * 0.03, 0.1, 0.175 + t * 0.04); // warm concrete
  return out.setHSL(0.6 + t * 0.04, 0.1, 0.165 + t * 0.04); // cool grey
}

/** The per-instance attributes of a city mesh, one slot layout. */
interface InstanceArrays {
  archetype: Float32Array;
  roof: Float32Array;
  led: Float32Array;
  crown: Float32Array;
  subOff: Float32Array;
  parent: Float32Array;
  hole: Float32Array;
  crew: Float32Array;
  color: Float32Array;
}

function allocArrays(n: number): InstanceArrays {
  return {
    archetype: new Float32Array(n * 2),
    roof: new Float32Array(n * 4),
    led: new Float32Array(n * 3),
    crown: new Float32Array(n * 3),
    subOff: new Float32Array(n * 4),
    parent: new Float32Array(n * 3),
    hole: new Float32Array(n * 4),
    crew: new Float32Array(n * 4),
    color: new Float32Array(n * 3),
  };
}

/** The unit box every city instance scales: origin at its base centre. */
function unitBox(): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

/** A city mesh over `arrays`: the SAME attribute set (and so the same
 * compiled program) for the intact city and the damaged buildings. */
function cityMesh(
  material: THREE.Material,
  arrays: InstanceArrays,
  capacity: number,
): THREE.InstancedMesh {
  const geometry = unitBox();
  const attr = (a: Float32Array, size: number) =>
    new THREE.InstancedBufferAttribute(a, size);
  // Static per-instance data — see writeSolid for what each one carries.
  // .x the facade archetype; .y D1's packed facade-damage slot word for the
  // box's tier (damage-map.ts), rewritten by flushDamage when it changes.
  const archetype = attr(arrays.archetype, 2);
  archetype.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aArchetype", archetype);
  geometry.setAttribute("aRoof", attr(arrays.roof, 4));
  geometry.setAttribute("aLed", attr(arrays.led, 3));
  geometry.setAttribute("aCrown", attr(arrays.crown, 3));
  geometry.setAttribute("aSubOff", attr(arrays.subOff, 4));
  geometry.setAttribute("aParent", attr(arrays.parent, 3));
  geometry.setAttribute("aHole", attr(arrays.hole, 4));
  geometry.setAttribute("aCrew", attr(arrays.crew, 4));
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Always present, so both meshes compile the one instancing-colour program.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(arrays.color, 3);
  mesh.frustumCulled = false; // instances move relative to the camera every frame
  return mesh;
}

/** Everything a building's instances carry besides their own box, derived
 * once per building. */
interface BuildingLook {
  arch: number;
  style: RoofStyle;
  crew: CrewSlot | undefined;
  /** H2: the hole's whole run along its axis, packed (packRun), or 0. */
  run: number;
  color: THREE.Color;
}

/**
 * Write one solid's attributes into slot `i` — every field, zeros included,
 * so a recycled slot of the damaged mesh carries nothing from its last
 * tenant.
 *
 *   aArchetype  facade archetype (all tiers of a building agree), and in .y
 *               D1's facade-damage slot word for the box's tier (`word`)
 *   aRoof       VO3: (roof kind, crown depth on the top tier else 0, tone, 0)
 *   aLed        VO3: boosted LED outline colour (0 = none)
 *   aCrown      VO3: crown wash tint × gain (top tier only)
 *   aSubOff     H1: this box's base-centre offset inside its PARENT tier
 *               (the facade is painted in the tier's frame, so a wall and
 *               the lintel over a hole — or D2's broken pieces — carry one
 *               continuous window grid); .w = D2's CUT_* mask
 *   aParent     the parent tier's (w, h, d)
 *   aHole       the tier's hole (across offset, half width, floor above the
 *               tier base, ±height: + travels along x, − along z; 0 = none)
 *   aCrew       L3 cleaning crew slot (start, duration, cycle) + H2 run in .w
 *   colour      VO2 facade albedo
 */
function writeSolid(
  a: InstanceArrays,
  i: number,
  b: Building,
  s: SolidBox,
  look: BuildingLook,
  word: number,
): void {
  const tier = b.tiers[s.tierIndex] as Building["tiers"][number];
  let tierBase = 0;
  for (let k = 0; k < s.tierIndex; k++) tierBase += b.tiers[k]?.height ?? 0;
  const isTop = s.tierIndex === b.tiers.length - 1;
  a.archetype[i * 2] = look.arch;
  a.archetype[i * 2 + 1] = word;
  a.roof[i * 4] = look.style.tierKinds[s.tierIndex] ?? 0;
  a.roof[i * 4 + 1] = isTop && look.style.crown ? look.style.crown.depth : 0;
  a.roof[i * 4 + 2] = look.style.tone;
  a.roof[i * 4 + 3] = 0;
  if (look.style.led) look.style.led.toArray(a.led, i * 3);
  else a.led.fill(0, i * 3, i * 3 + 3);
  if (isTop && look.style.crown) look.style.crown.color.toArray(a.crown, i * 3);
  else a.crown.fill(0, i * 3, i * 3 + 3);
  a.subOff[i * 4] = s.dx;
  a.subOff[i * 4 + 1] = s.baseY - tierBase;
  a.subOff[i * 4 + 2] = s.dz;
  a.subOff[i * 4 + 3] = s.cut;
  a.parent[i * 3] = tier.width;
  a.parent[i * 3 + 1] = tier.height;
  a.parent[i * 3 + 2] = tier.depth;
  const h = b.holes?.find((x) => x.tierIndex === s.tierIndex);
  if (h) {
    a.hole[i * 4] = h.offset;
    a.hole[i * 4 + 1] = h.width / 2;
    a.hole[i * 4 + 2] = h.y0 - tierBase;
    a.hole[i * 4 + 3] = h.axis === "x" ? h.height : -h.height;
  } else {
    a.hole.fill(0, i * 4, i * 4 + 4);
  }
  const slot = look.crew;
  a.crew[i * 4] = slot ? slot.start : 0;
  a.crew[i * 4 + 1] = slot ? slot.duration : 0;
  a.crew[i * 4 + 2] = slot ? slot.cycle : 0;
  a.crew[i * 4 + 3] = h ? look.run : 0;
  look.color.toArray(a.color, i * 3);
}

/** A matrix that draws nothing (a hidden or spare slot). */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
/** No image yet — forces a damaged building's first placement. */
const UNSET = 0x7fff;
/** Spare slots a damaged building's range keeps for its next few breaks. */
const RANGE_SLACK = 6;
/** Past this many dirty ranges a frame uploads the used prefix once. */
const MAX_DIRTY = 32;

export class CityRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly buildings: Building[];
  private readonly index: CityIndex;
  /** The intact city's boxes: every building's base solids, in order. */
  private readonly instances: SolidBox[];
  /** Building b's base instances are [first[b], first[b + 1]). */
  private readonly first: Int32Array;
  private readonly owner: Int32Array;
  private readonly looks: BuildingLook[];
  private readonly scratch = new THREE.Matrix4();
  private readonly images: ImageCache;
  private readonly uploads: InstanceUploads;
  /** L3 living windows: the shader's live clock and its uniform. */
  private readonly liveClock = new LiveClock();
  private readonly liveTime = { value: 0 };
  private readonly material: THREE.Material;

  /** D1: the facade damage map (scorch, dark windows) and its GPU atlas. */
  readonly damage = new FacadeDamage();
  private readonly damageTexture = new DamageTexture(this.damage);
  /** D1: each building's index in `buildings` — the damage map's id. */
  private readonly buildingIndex = new Map<Building, number>();
  /** D1: base instance indices per tier (tierKey), for the slot-word
   * re-pack. */
  private readonly tierInstances = new Map<number, number[]>();

  // --- D2: damaged buildings ---
  private cityDamage: CityDamage | null = null;
  private damageVersion = -1;
  /** 1 while a base instance is hidden (its building is drawn damaged). */
  private readonly hidden: Uint8Array;
  /** Each base instance's current image anchor (where place() put it). */
  private readonly imgX: Float64Array;
  private readonly imgZ: Float64Array;
  /** The damage version each building is drawn at (0 = intact). */
  private readonly drawnVersion: Float64Array;
  /** Each damaged building's slot range in the damaged mesh: start (−1 =
   * none), capacity, used; and its drawn torus image. */
  private readonly slotStart: Int32Array;
  private readonly slotCap: Int32Array;
  private readonly slotUsed: Int32Array;
  private readonly dkx: Int16Array;
  private readonly dkz: Int16Array;
  /** Buildings currently drawn damaged. */
  private readonly damagedList: number[] = [];
  private damaged: THREE.InstancedMesh;
  private dArrays: InstanceArrays;
  private dCapacity: number;
  /** First never-used slot of the damaged mesh. */
  private dNext = 0;
  /** Dirty [start, end) slot ranges: attributes, and matrices only. */
  private readonly dirtyAttr: number[] = [];
  private readonly dirtyMat: number[] = [];

  // --- D3: collapse debris ---
  private collapseField: CollapseField | null = null;
  private collapseVersion = -1;
  private debris: THREE.InstancedMesh | null = null;
  private bArrays: InstanceArrays | null = null;
  private bCapacity = 0;
  /** The collapses drawn, in field order, and each one's first slot. */
  private readonly drawn: Collapse[] = [];
  private readonly drawnStart: number[] = [];
  /** Each collapse's drawn torus image, and whether it was last written
   * fully at rest there (nothing left to move). */
  private readonly drawnKx: number[] = [];
  private readonly drawnKz: number[] = [];
  private readonly drawnSettled: boolean[] = [];
  /** Per slot: 1 while drawn as rubble (its cut word says CUT_RUBBLE). */
  private bRest = new Uint8Array(0);
  private bNext = 0;
  /** Slots whose matrices / attributes changed this frame: [lo, hi). */
  private bMatLo = Number.POSITIVE_INFINITY;
  private bMatHi = 0;
  private bAttrLo = Number.POSITIVE_INFINITY;
  private bAttrHi = 0;
  private readonly bPose = blankPose();

  constructor(seed: number) {
    this.buildings = generateCity(seed);
    this.buildings.forEach((b, i) => this.buildingIndex.set(b, i));
    // Built once, beside the array it describes, so the per-frame crash probe
    // costs a couple of block lookups instead of a scan of the whole city.
    this.index = buildCityIndex(this.buildings);

    // Flatten the solids: the rendered silhouette is exactly the collision
    // volume, so instances come 1:1 from the shared solids() — a holed tier
    // is a few extra INSTANCES of the same mesh, never an extra draw. The
    // intact city's (base) solids: a building destruction reaches is hidden
    // here and drawn from its live solids() by the damaged mesh.
    const n = this.buildings.length;
    this.first = new Int32Array(n + 1);
    this.instances = [];
    const owners: number[] = [];
    this.buildings.forEach((b, i) => {
      this.first[i] = this.instances.length;
      for (const s of baseSolids(b)) {
        this.instances.push(s);
        owners.push(i);
      }
    });
    this.first[n] = this.instances.length;
    this.owner = Int32Array.from(owners);

    const rota = crewSchedule(this.buildings, seed);
    const spanOf = new Map<Building, HoleSpan>();
    for (const s of cityHoles(this.buildings)) {
      for (const h of s.hosts) spanOf.set(h, s);
    }
    this.looks = this.buildings.map((b) => {
      const arch = archetypeFor(b);
      const s = spanOf.get(b);
      let run = 0;
      if (s) {
        const x = s.hole.axis === "x";
        // Tiers are centred on the building, so its (x, z) is the tier origin.
        const lo = wrapDeltaAxis(x ? b.x : b.z, x ? s.entry.x : s.entry.z);
        run = packRun(lo, lo + s.length);
      }
      return {
        arch,
        style: roofStyleFor(b),
        crew: rota.get(b),
        run,
        color: facadeColor(b, arch),
      };
    });

    // Night-neon material with procedural emissive window grids (T5 art pass),
    // branching per instance on the facade archetype.
    this.material = createBuildingsMaterial(
      this.liveTime,
      this.damageTexture.texture,
    );
    const arrays = allocArrays(this.instances.length);
    this.instances.forEach((s, i) => {
      const b = this.owner[i] as number;
      writeSolid(
        arrays,
        i,
        this.buildings[b] as Building,
        s,
        this.looks[b] as BuildingLook,
        this.damage.packedWord(b, s.tierIndex),
      );
      const key = tierKey(b, s.tierIndex);
      let list = this.tierInstances.get(key);
      if (!list) {
        list = [];
        this.tierInstances.set(key, list);
      }
      list.push(i);
    });
    this.mesh = cityMesh(this.material, arrays, this.instances.length);
    this.images = new ImageCache(
      this.instances.map(
        (_, i) => this.buildings[this.owner[i] as number]?.x ?? 0,
      ),
      this.instances.map(
        (_, i) => this.buildings[this.owner[i] as number]?.z ?? 0,
      ),
    );
    this.uploads = new InstanceUploads([this.mesh.instanceMatrix]);
    this.hidden = new Uint8Array(this.instances.length);
    this.imgX = new Float64Array(this.instances.length);
    this.imgZ = new Float64Array(this.instances.length);

    this.drawnVersion = new Float64Array(n);
    this.slotStart = new Int32Array(n).fill(-1);
    this.slotCap = new Int32Array(n);
    this.slotUsed = new Int32Array(n);
    this.dkx = new Int16Array(n).fill(UNSET);
    this.dkz = new Int16Array(n).fill(UNSET);
    this.dCapacity = 256;
    this.dArrays = allocArrays(this.dCapacity);
    this.damaged = this.newDamagedMesh();
  }

  /** The same Building[] the renderer draws — collision's single source of truth. */
  get cityBuildings(): readonly Building[] {
    return this.buildings;
  }

  /** Block index over `cityBuildings`, for collideCity's 4th argument. */
  get cityIndex(): CityIndex {
    return this.index;
  }

  /** Instance count actually drawn (one per solid: a tier, or a wall /
   * lintel / sill of a holed tier) — perf reporting/QA. Damaged buildings
   * count their live boxes instead of their hidden intact ones. */
  get tierInstanceCount(): number {
    let n = this.instances.length;
    for (const b of this.damagedList) {
      n += (this.slotUsed[b] as number) - this.baseCount(b);
    }
    return n;
  }

  /** D2: draw (and let collision see) `damage` — the GameSocket's mirror of
   * the room's destroyed set. Binds it to this city's buildings. */
  attachDamage(damage: CityDamage): void {
    damage.bind(this.buildings);
    this.cityDamage = damage;
    this.damageVersion = -1;
  }

  /**
   * D3: draw `field`'s debris — the GameSocket's collapse records. Binds it
   * to this city's buildings (the same array collision reads) and sizes the
   * debris mesh once for everything COLLAPSE_CAP lets fall.
   */
  attachCollapses(field: CollapseField): void {
    field.bind(this.buildings);
    this.collapseField = field;
    this.collapseVersion = -1;
    let chunks = 0;
    for (const b of this.buildings) {
      for (const mask of chunkMask(b)) for (const v of mask) chunks += v;
    }
    // A hole can split a chunk into up to three pieces; most are one.
    this.growDebris(Math.ceil(chunks * COLLAPSE_CAP * 1.25) + 64);
  }

  /**
   * D3: pose every collapse's debris at the server time `serverMs` — the
   * render clock the crash check uses (null: no clock yet, so the rest
   * state, which is what collides then too) — at its torus image nearest
   * the camera.
   */
  updateDebris(cameraPos: Vec3, serverMs: number | null): void {
    const field = this.collapseField;
    const debris = this.debris;
    if (!field || !debris) return;
    if (field.version !== this.collapseVersion) {
      this.collapseVersion = field.version;
      this.syncCollapses(field);
    }
    const t = serverMs ?? Number.POSITIVE_INFINITY;
    const subOff = debris.geometry.getAttribute(
      "aSubOff",
    ) as THREE.BufferAttribute;
    for (let k = 0; k < this.drawn.length; k++) {
      const c = this.drawn[k] as Collapse;
      const kx = imageIndex(cameraPos.x, c.x);
      const kz = imageIndex(cameraPos.z, c.z);
      const settled = t >= c.t0 + c.endMs;
      if (
        settled &&
        this.drawnSettled[k] &&
        kx === this.drawnKx[k] &&
        kz === this.drawnKz[k]
      ) {
        continue;
      }
      this.drawnKx[k] = kx;
      this.drawnKz[k] = kz;
      this.drawnSettled[k] = settled;
      const start = this.drawnStart[k] as number;
      const ox = c.x + kx * WORLD_SIZE;
      const oz = c.z + kz * WORLD_SIZE;
      for (let i = 0; i < c.n; i++) {
        const pose = piecePose(c, i, t, this.bPose);
        debris.setMatrixAt(start + i, pieceMatrix(pose, ox, oz, this.scratch));
        const rest = pose.rest ? 1 : 0;
        if (this.bRest[start + i] !== rest) {
          this.bRest[start + i] = rest;
          subOff.setW(start + i, rest ? CUT_RUBBLE : (c.cut[i] as number));
          this.bAttrLo = Math.min(this.bAttrLo, start + i);
          this.bAttrHi = Math.max(this.bAttrHi, start + i + 1);
        }
      }
      this.bMatLo = Math.min(this.bMatLo, start);
      this.bMatHi = Math.max(this.bMatHi, start + c.n);
    }
    this.flushDebris();
  }

  /** Bring the drawn collapses in line with the field: append new ones; on
   * a reset (or any other change to what is already drawn) start over. */
  private syncCollapses(field: CollapseField): void {
    const list = field.list;
    let same = list.length >= this.drawn.length;
    for (let k = 0; same && k < this.drawn.length; k++) {
      same = list[k] === this.drawn[k];
    }
    if (!same) {
      const debris = this.debris as THREE.InstancedMesh;
      for (let i = 0; i < this.bNext; i++) debris.setMatrixAt(i, HIDDEN);
      this.bMatLo = 0;
      this.bMatHi = Math.max(this.bMatHi, this.bNext);
      this.bRest.fill(0);
      this.bNext = 0;
      this.drawn.length = 0;
      this.drawnStart.length = 0;
      this.drawnKx.length = 0;
      this.drawnKz.length = 0;
      this.drawnSettled.length = 0;
    }
    for (let k = this.drawn.length; k < list.length; k++) {
      const c = list[k] as Collapse;
      if (this.bNext + c.n > this.bCapacity) {
        this.growDebris(Math.max(this.bCapacity * 2, this.bNext + c.n));
      }
      this.drawn.push(c);
      this.drawnStart.push(this.bNext);
      this.drawnKx.push(UNSET);
      this.drawnKz.push(UNSET);
      this.drawnSettled.push(false);
      this.writeCollapse(c, this.bNext);
      this.bNext += c.n;
    }
    (this.debris as THREE.InstancedMesh).count = this.bNext;
  }

  /** Write collapse `c`'s per-piece attributes from slot `start`: each piece
   * as the solid it was in its building (its tier frame, its facade). */
  private writeCollapse(c: Collapse, start: number): void {
    const arrays = this.bArrays as InstanceArrays;
    const building = this.buildings[c.building] as Building;
    const look = this.looks[c.building] as BuildingLook;
    for (let i = 0; i < c.n; i++) {
      const hy = c.hy[i] as number;
      const solid: SolidBox = {
        dx: c.ox[i] as number,
        dz: c.oz[i] as number,
        baseY: (c.oy[i] as number) - hy,
        width: 2 * (c.hx[i] as number),
        height: 2 * hy,
        depth: 2 * (c.hz[i] as number),
        tierIndex: c.tier[i] as number,
        cut: c.cut[i] as number,
      };
      const word = this.damage.packedWord(c.building, solid.tierIndex);
      writeSolid(arrays, start + i, building, solid, look, word);
      this.bRest[start + i] = 0;
    }
    this.bAttrLo = Math.min(this.bAttrLo, start);
    this.bAttrHi = Math.max(this.bAttrHi, start + c.n);
  }

  /** A debris mesh of `capacity` slots, every drawn collapse rewritten. */
  private growDebris(capacity: number): void {
    this.bCapacity = capacity;
    this.bArrays = allocArrays(capacity);
    const rest = new Uint8Array(capacity);
    rest.set(this.bRest.subarray(0, Math.min(this.bRest.length, capacity)));
    this.bRest = rest;
    if (this.debris) {
      this.debris.removeFromParent();
      this.debris.geometry.dispose();
    }
    const mesh = cityMesh(this.material, this.bArrays, capacity);
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, HIDDEN);
    mesh.count = this.bNext;
    this.mesh.add(mesh);
    this.debris = mesh;
    const subOff = mesh.geometry.getAttribute(
      "aSubOff",
    ) as THREE.BufferAttribute;
    this.drawn.forEach((c, k) => {
      const start = this.drawnStart[k] as number;
      this.writeCollapse(c, start);
      for (let i = 0; i < c.n; i++) {
        if (this.bRest[start + i]) subOff.setW(start + i, CUT_RUBBLE);
      }
      this.drawnKx[k] = UNSET;
    });
    this.bMatLo = this.bAttrLo = 0;
    this.bMatHi = this.bAttrHi = capacity;
  }

  /** Upload this frame's debris changes: one range per kind. */
  private flushDebris(): void {
    const debris = this.debris;
    if (!debris) return;
    const upload = (
      attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null,
      lo: number,
      hi: number,
    ) => {
      if (!attr || !(attr instanceof THREE.BufferAttribute)) return;
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * attr.itemSize, (hi - lo) * attr.itemSize);
      attr.needsUpdate = true;
    };
    if (this.bAttrHi > this.bAttrLo) {
      const geo = debris.geometry;
      for (const name of [
        "aArchetype",
        "aRoof",
        "aLed",
        "aCrown",
        "aSubOff",
        "aParent",
        "aHole",
        "aCrew",
      ]) {
        upload(geo.getAttribute(name), this.bAttrLo, this.bAttrHi);
      }
      upload(debris.instanceColor, this.bAttrLo, this.bAttrHi);
    }
    if (this.bMatHi > this.bMatLo) {
      upload(debris.instanceMatrix, this.bMatLo, this.bMatHi);
    }
    this.bMatLo = this.bAttrLo = Number.POSITIVE_INFINITY;
    this.bMatHi = this.bAttrHi = 0;
  }

  /** QA/tests: the debris mesh, and collapse `id`'s first slot (−1: not
   * drawn). */
  debrisSlots(id: number): { mesh: THREE.InstancedMesh | null; start: number } {
    const k = this.drawn.findIndex((c) => c.id === id);
    return {
      mesh: this.debris,
      start: k < 0 ? -1 : (this.drawnStart[k] as number),
    };
  }

  /** Place every solid at its building's torus image nearest the camera —
   * rewriting and uploading only the solids whose image flipped — after
   * bringing damaged buildings up to the current destroyed set. */
  update(cameraPos: Vec3): void {
    if (this.cityDamage && this.cityDamage.version !== this.damageVersion) {
      this.damageVersion = this.cityDamage.version;
      this.syncDamage();
    }
    this.images.update(cameraPos, this.place);
    this.uploads.flush();
    this.placeDamaged(cameraPos);
  }

  private readonly place = (i: number, x: number, z: number): void => {
    this.imgX[i] = x;
    this.imgZ[i] = z;
    this.writeBase(i);
  };

  /** Base instance `i` at its current image — or nothing, while hidden (an
   * image flip must never bring an intact copy back over a broken one). */
  private writeBase(i: number): void {
    if (this.hidden[i]) {
      this.mesh.setMatrixAt(i, HIDDEN);
    } else {
      const s = this.instances[i] as SolidBox;
      this.scratch.makeScale(s.width, s.height, s.depth);
      this.scratch.setPosition(
        (this.imgX[i] as number) + s.dx,
        s.baseY,
        (this.imgZ[i] as number) + s.dz,
      );
      this.mesh.setMatrixAt(i, this.scratch);
    }
    this.uploads.mark(i);
  }

  private baseCount(b: number): number {
    return (this.first[b + 1] as number) - (this.first[b] as number);
  }

  /** Hide or show building `b`'s base instances. */
  private setHidden(b: number, hide: boolean): void {
    for (
      let i = this.first[b] as number;
      i < (this.first[b + 1] as number);
      i++
    ) {
      this.hidden[i] = hide ? 1 : 0;
      this.writeBase(i);
    }
  }

  /** Bring every building whose damage version moved up to date. */
  private syncDamage(): void {
    for (let b = 0; b < this.buildings.length; b++) {
      const building = this.buildings[b] as Building;
      const v = building.damage?.version ?? 0;
      if (v === this.drawnVersion[b]) continue;
      this.drawnVersion[b] = v;
      if (v === 0) this.release(b);
      else this.redraw(b);
    }
    this.damaged.count = this.dNext;
  }

  /** Building `b` is whole again: drop its damaged slots, show its base. */
  private release(b: number): void {
    const start = this.slotStart[b] as number;
    if (start >= 0) {
      for (let k = 0; k < (this.slotCap[b] as number); k++) {
        this.damaged.setMatrixAt(start + k, HIDDEN);
      }
      this.markDirty(this.dirtyMat, start, start + (this.slotCap[b] as number));
    }
    // The range is abandoned (the next grow() compacts it away).
    this.slotStart[b] = -1;
    this.slotCap[b] = 0;
    this.slotUsed[b] = 0;
    const at = this.damagedList.indexOf(b);
    if (at >= 0) this.damagedList.splice(at, 1);
    this.setHidden(b, false);
  }

  /** Building `b`'s solids changed: rewrite its slot range from solids(). */
  private redraw(b: number): void {
    const building = this.buildings[b] as Building;
    const boxes = solids(building);
    if ((this.slotCap[b] as number) < boxes.length) {
      // Outgrown: the old range is abandoned (blanked) and a new one taken
      // at the end; growing the mesh compacts every range.
      const old = this.slotStart[b] as number;
      if (old >= 0) {
        for (let k = 0; k < (this.slotCap[b] as number); k++) {
          this.damaged.setMatrixAt(old + k, HIDDEN);
        }
        this.markDirty(this.dirtyMat, old, old + (this.slotCap[b] as number));
      }
      const cap = boxes.length + RANGE_SLACK;
      if (this.dNext + cap > this.dCapacity) {
        this.slotStart[b] = -1;
        this.slotCap[b] = cap;
        if (!this.damagedList.includes(b)) this.damagedList.push(b);
        this.grow();
        this.setHidden(b, true);
        return;
      }
      this.slotStart[b] = this.dNext;
      this.slotCap[b] = cap;
      this.dNext += cap;
    }
    this.writeRange(b, boxes);
    if (!this.damagedList.includes(b)) this.damagedList.push(b);
    this.setHidden(b, true);
  }

  /** Write building `b`'s boxes into its range; blank the spare slots. */
  private writeRange(b: number, boxes: readonly SolidBox[]): void {
    const building = this.buildings[b] as Building;
    const start = this.slotStart[b] as number;
    const look = this.looks[b] as BuildingLook;
    for (let k = 0; k < boxes.length; k++) {
      const s = boxes[k] as SolidBox;
      const word = this.damage.packedWord(b, s.tierIndex);
      writeSolid(this.dArrays, start + k, building, s, look, word);
    }
    for (let k = boxes.length; k < (this.slotCap[b] as number); k++) {
      this.damaged.setMatrixAt(start + k, HIDDEN);
    }
    this.slotUsed[b] = boxes.length;
    this.markDirty(this.dirtyAttr, start, start + (this.slotCap[b] as number));
    // Force its matrices out on the next placement.
    this.dkx[b] = UNSET;
  }

  /** Double the damaged mesh (at least to fit every range) and compact:
   * every damaged building gets a fresh range, written from its solids. */
  private grow(): void {
    let need = 0;
    for (const b of this.damagedList) need += this.slotCap[b] as number;
    while (this.dCapacity < need) this.dCapacity *= 2;
    this.dCapacity *= 2;
    this.dArrays = allocArrays(this.dCapacity);
    this.damaged.removeFromParent();
    this.damaged.geometry.dispose();
    this.damaged = this.newDamagedMesh();
    this.dNext = 0;
    for (const b of this.damagedList) {
      this.slotStart[b] = this.dNext;
      this.dNext += this.slotCap[b] as number;
      this.writeRange(b, solids(this.buildings[b] as Building));
    }
    this.dirtyAttr.length = 0;
    this.dirtyMat.length = 0;
    this.dirtyAll = true;
  }

  private dirtyAll = false;

  private newDamagedMesh(): THREE.InstancedMesh {
    const mesh = cityMesh(this.material, this.dArrays, this.dCapacity);
    for (let i = 0; i < this.dCapacity; i++) mesh.setMatrixAt(i, HIDDEN);
    mesh.count = 0;
    // A child of the city mesh: same transform (identity), no scene wiring.
    this.mesh.add(mesh);
    return mesh;
  }

  /** Damaged buildings at their torus image nearest the camera — rewriting
   * only buildings whose image flipped or whose boxes changed. */
  private placeDamaged(cameraPos: Vec3): void {
    for (let n = 0; n < this.damagedList.length; n++) {
      const b = this.damagedList[n] as number;
      const building = this.buildings[b] as Building;
      const kx = imageIndex(cameraPos.x, building.x);
      const kz = imageIndex(cameraPos.z, building.z);
      if (kx === this.dkx[b] && kz === this.dkz[b]) continue;
      this.dkx[b] = kx;
      this.dkz[b] = kz;
      const x = building.x + kx * WORLD_SIZE;
      const z = building.z + kz * WORLD_SIZE;
      const start = this.slotStart[b] as number;
      const boxes = solids(building);
      const used = Math.min(this.slotUsed[b] as number, boxes.length);
      for (let k = 0; k < used; k++) {
        const s = boxes[k] as SolidBox;
        this.scratch.makeScale(s.width, s.height, s.depth);
        this.scratch.setPosition(x + s.dx, s.baseY, z + s.dz);
        this.damaged.setMatrixAt(start + k, this.scratch);
      }
      this.markDirty(this.dirtyMat, start, start + used);
    }
    this.flushDamaged();
  }

  private markDirty(list: number[], start: number, end: number): void {
    if (end > start) list.push(start, end);
  }

  /** Upload what changed in the damaged mesh this frame. */
  private flushDamaged(): void {
    if (
      !this.dirtyAll &&
      this.dirtyAttr.length === 0 &&
      this.dirtyMat.length === 0
    ) {
      return; // the common frame: nothing broke, nothing flipped
    }
    const geo = this.damaged.geometry;
    const attrs = [
      geo.getAttribute("aArchetype"),
      geo.getAttribute("aRoof"),
      geo.getAttribute("aLed"),
      geo.getAttribute("aCrown"),
      geo.getAttribute("aSubOff"),
      geo.getAttribute("aParent"),
      geo.getAttribute("aHole"),
      geo.getAttribute("aCrew"),
      this.damaged.instanceColor,
    ];
    const upload = (
      attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null,
      ranges: number[],
    ) => {
      if (!attr || !(attr instanceof THREE.BufferAttribute)) return;
      attr.clearUpdateRanges();
      if (!this.dirtyAll && ranges.length <= MAX_DIRTY * 2) {
        for (let r = 0; r < ranges.length; r += 2) {
          const s = ranges[r] as number;
          attr.addUpdateRange(
            s * attr.itemSize,
            ((ranges[r + 1] as number) - s) * attr.itemSize,
          );
        }
      }
      attr.needsUpdate = true;
    };
    if (this.dirtyAll || this.dirtyAttr.length > 0) {
      for (const attr of attrs) upload(attr, this.dirtyAttr);
    }
    if (
      this.dirtyAll ||
      this.dirtyMat.length > 0 ||
      this.dirtyAttr.length > 0
    ) {
      // Attribute rewrites also re-place their slots (dkx was reset).
      upload(this.damaged.instanceMatrix, [
        ...this.dirtyMat,
        ...this.dirtyAttr,
      ]);
    }
    this.dirtyAttr.length = 0;
    this.dirtyMat.length = 0;
    this.dirtyAll = false;
  }

  /** QA/tests: the damaged mesh, and building `b`'s slot range in it. */
  damagedSlots(b: number): {
    mesh: THREE.InstancedMesh;
    start: number;
    used: number;
  } {
    return {
      mesh: this.damaged,
      start: this.slotStart[b] as number,
      used: this.slotUsed[b] as number,
    };
  }

  /** QA/tests: is base instance `i` of building `b` hidden? */
  baseHidden(b: number): boolean {
    const i = this.first[b] as number;
    return this.hidden[i] === 1;
  }

  /**
   * D1: push this frame's facade damage to the GPU — the dirty atlas slots
   * as sub-rectangles, and the packed slot word of every tier whose slots
   * changed: its base instances, and (D2) its boxes in the damaged mesh.
   * Only those instances' ranges are re-uploaded.
   */
  flushDamage(renderer: THREE.WebGLRenderer): void {
    const base = this.mesh.geometry.getAttribute(
      "aArchetype",
    ) as THREE.InstancedBufferAttribute;
    const data = base.array as Float32Array;
    const dData = this.dArrays.archetype;
    let any = false;
    this.damage.takeDirtyTiers((key) => {
      const building = Math.floor(key / 8);
      const tier = key % 8;
      const word = this.damage.packedWord(building, tier);
      const list = this.tierInstances.get(key);
      if (list) {
        if (!any) base.clearUpdateRanges();
        any = true;
        for (const i of list) {
          data[i * 2 + 1] = word;
          base.addUpdateRange(i * 2 + 1, 1);
        }
      }
      const start = this.slotStart[building] ?? -1;
      if (start < 0) return;
      const boxes = solids(this.buildings[building] as Building);
      const used = this.slotUsed[building] as number;
      for (let k = 0; k < used; k++) {
        if ((boxes[k] as SolidBox).tierIndex !== tier) continue;
        dData[(start + k) * 2 + 1] = word;
      }
      this.markDirty(this.dirtyAttr, start, start + used);
    });
    if (any) base.needsUpdate = true;
    this.damageTexture.flush(renderer);
  }

  /** D1: the damage atlas the shader samples (prewarm uploads it). */
  get damageAtlas(): THREE.Texture {
    return this.damageTexture.texture;
  }

  /** D1: the building's id in the damage map (its generateCity index). */
  indexOf(b: Building): number {
    return this.buildingIndex.get(b) ?? -1;
  }

  /** L3: advance the living-windows clock (server ms, null before the first
   * snapshot; `nowMs` = the frame's performance.now()). */
  updateLiveWindows(serverMs: number | null, nowMs: number): void {
    this.liveTime.value = this.liveClock.update(serverMs, nowMs);
  }

  /** O3: Low turns the L3 living windows off — a uniform, so no recompile.
   * M3: Mobile also drops the parallax window rooms, the same way. D2: Low
   * and Mobile drop the rebar and jagged rims of broken faces. */
  setQuality(tier: QualityTier): void {
    // D1: fewer facade damage slots on the cheaper tiers (a count only).
    this.damage.setSlotCap(faceSlotsFor(QUALITY_PROFILES[tier].impacts));
    LIVE_ON_UNIFORM.value = QUALITY_PROFILES[tier].livingWindows ? 1 : 0;
    WIN_INTERIOR_UNIFORM.value = QUALITY_PROFILES[tier].windowInteriors ? 1 : 0;
    BROKEN_DETAIL_UNIFORM.value = QUALITY_PROFILES[tier].destructionDetail
      ? 1
      : 0;
  }

  /** QA: pin the living-windows clock (live seconds), or null to follow the server. */
  pinLiveWindows(sec: number | null): void {
    this.liveClock.pinned = sec;
  }
}

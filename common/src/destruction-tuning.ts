// DL1 Destruction Lab — every building-destruction tunable as ONE typed
// object, the FL1 Flight Lab idiom (common/src/tuning.ts) applied to D2–D11.
//
// `DEFAULT_DESTRUCTION_TUNING` is today's game, value for value: every field
// is built from the very constant it mirrors (constants.ts for the shared
// model, the client modules' own names for the look), and every multiplier
// defaults to exactly 1 — so a reader that swaps `CONST` for `t.field` (or
// `CONST * t.mult`) computes the same doubles bit for bit. The shared
// collapse model (city/collapse.ts) takes a tuning as a trailing
// `tuning = DEFAULT_DESTRUCTION_TUNING` parameter, the server's chain blasts
// read the room city's, and the client renderers read one live look object
// that only the Destruction Lab ever writes — normal rooms are structurally
// on the defaults (common/test/destruction-parity.test.ts proves it).
//
// Three scopes, one spec:
//   - BUILD fields shape a collapse's debris — what draws AND collides. In a
//     Destruction Lab room the server stamps their diff on every collapse
//     wire it makes (`CollapseWire.dt`); a lab CollapseField builds from
//     it, so the server, the lab client and a late joiner build the same
//     debris (draw == collide holds inside the lab too). Normal rooms never
//     stamp it, and a normal field never reads it.
//   - SERVER fields are the room's planner and chain reactions (D3, D5):
//     what falls, and how hard falling debris hits the neighbours.
//   - LOOK fields are client-only dressing: dust, particles, fire, LOD and
//     budgets. Nothing in them collides.
//
// `DESTRUCTION_SPEC` describes every field once — its group, scope,
// plain-English label and hint, range and step — and drives the lab's
// sliders and the clamping of anything imported (a pasted export, a share
// link, a lab room's wire message, a stamped wire). Exports are versioned
// and carry only what differs from the default.
//
// Units: angles are stored in rad exactly as the code reads them (`scale`
// converts for display only); times in ms; lengths in m.

import {
  CHAIN_BLAST_DAMAGE,
  CHAIN_BLAST_RADIUS,
  CHAIN_DEPTH_MAX,
  CHAIN_ENERGY_MAX,
  CHAIN_ENERGY_MIN,
  CHAIN_ENERGY_REF,
  CHAIN_IMPACTS_MAX,
  CHAIN_IMPACTS_PER_BUILDING,
  COLLAPSE_BAND_MIN,
  COLLAPSE_COLUMN_LEAN,
  COLLAPSE_COLUMN_RUBBLE,
  COLLAPSE_COLUMN_SHARE,
  COLLAPSE_CREEP_MS,
  COLLAPSE_CRUSH_G,
  COLLAPSE_GRAVITY,
  COLLAPSE_LEAD_MS,
  COLLAPSE_PANCAKE_TILT,
  COLLAPSE_RUBBLE_RATIO,
  COLLAPSE_SHEET_BREAK,
  COLLAPSE_SHEET_DRIFT,
  COLLAPSE_SHEET_SHARE,
  COLLAPSE_SLAB_STOREY,
  COLLAPSE_SLUMP_MAX,
  COLLAPSE_SLUMP_RISE,
  COLLAPSE_SQUASH_MS,
  COLLAPSE_SYMMETRY,
  COLLAPSE_TOPPLE_BREAK,
  COLLAPSE_TOPPLE_BREAK_TOP,
  COLLAPSE_TOPPLE_DRIFT,
  COLLAPSE_TOPPLE_K,
} from "./constants";

const DEG = Math.PI / 180;

/** base64 both runtimes have (browsers and Node ≥ 16); common/ compiles
 * without the DOM lib, so they are typed here. */
const b64 = globalThis as unknown as {
  btoa: (s: string) => string;
  atob: (s: string) => string;
};

/** Bumped whenever a field's meaning changes; imports refuse newer ones. */
export const DESTRUCTION_TUNING_VERSION = 1;

/** The client look defaults that have no home in constants.ts. Their
 * modules (render/dust.ts, render/collapse-fx.ts) read them from here. */
export const LOOK_DEFAULTS = {
  /** dust.ts DUST_OPACITY. */
  dustOpacity: 0.8,
  /** dust.ts DUST_COVERAGE_MAX: the drawn cloud's frame-share cap. */
  dustCoverageMax: 0.7,
  /** collapse-fx.ts TRAIL_RATE: trail emissions per second per collapse. */
  trailRate: 40,
  /** collapse-fx.ts BURST: a floor event's burst, particles. */
  gravelBurst: 26,
  dustBurst: 10,
  glassBurst: 34,
  /** collapse-fx.ts FIRE_CHANCE / FLASH_CHANCE: a crush-front burst's
   * chance of fire and of an electrical flash. */
  fireChance: 0.55,
  flashChance: 0.16,
  /** collapse-fx.ts DETAIL_RANGE_M / COLLAPSES_NEAR / RATE_MAX. */
  detailRange: 650,
  collapsesNear: 3,
  particleBudget: 600,
  /** dust.ts MAX_CLOUDS (the buffer is sized for this many; the lab can
   * only lower it). */
  dustClouds: 6,
} as const;

export interface DestructionTuning {
  // --- Structure (build: how the section moves) ---
  /** Gravity on falling debris, m/s² (COLLAPSE_GRAVITY). */
  gravity: number;
  /** Pancake: the crush front's acceleration, share of gravity
   * (COLLAPSE_CRUSH_G). */
  crushG: number;
  /** The beat before anything moves, ms (COLLAPSE_LEAD_MS). */
  leadMs: number;
  /** Pancake: the failure floor's creep before the block lets go, ms
   * (COLLAPSE_CREEP_MS). */
  creepMs: number;
  /** Topple: angular acceleration = K · g / height (COLLAPSE_TOPPLE_K). */
  toppleK: number;
  /** Topple: the base's break-up tilt, rad (COLLAPSE_TOPPLE_BREAK). */
  toppleBreak: number;
  /** Topple: the top's break-up tilt, rad (COLLAPSE_TOPPLE_BREAK_TOP). */
  toppleBreakTop: number;
  /** Topple: share of its swing's throw a chunk keeps
   * (COLLAPSE_TOPPLE_DRIFT). */
  toppleDrift: number;
  // --- Structure (server: what fails) ---
  /** A floor band with fewer than this share standing fails
   * (COLLAPSE_BAND_MIN). */
  bandMin: number;
  /** Survivors this close to the centre pancake, further off topple
   * (COLLAPSE_SYMMETRY). */
  symmetry: number;

  // --- Debris (build) ---
  /** Storey slab height a chunk breaks into, m (COLLAPSE_SLAB_STOREY):
   * smaller = more, smaller fragments. */
  slabStorey: number;
  /** Taller towers break into bigger slabs: the slab height × (1 + this ×
   * height / 300 m) — the fragment size distribution by building size
   * (0: every tower alike, today). */
  slabGrowth: number;
  /** Share of outline chunks that peel a facade sheet
   * (COLLAPSE_SHEET_SHARE). */
  sheetShare: number;
  /** A peeling sheet's break-off tilt, rad (COLLAPSE_SHEET_BREAK). */
  sheetBreak: number;
  /** Share of its outward speed a sheet keeps (COLLAPSE_SHEET_DRIFT). */
  sheetDrift: number;
  /** Share of chunk solids carrying a column / I-beam segment
   * (COLLAPSE_COLUMN_SHARE): the steel in the pile. */
  columnShare: number;
  /** A column stub's lean at rest, rad (COLLAPSE_COLUMN_LEAN). */
  columnLean: number;
  /** Share of its height a column keeps at rest (COLLAPSE_COLUMN_RUBBLE). */
  columnRubble: number;
  /** A landed slab squashes to this share of its height
   * (COLLAPSE_RUBBLE_RATIO): the mound's height. */
  rubbleRatio: number;
  /** Rubble's largest slump tilt, rad (COLLAPSE_SLUMP_MAX). */
  slumpMax: number;
  /** Rubble's largest far-edge rise, m (COLLAPSE_SLUMP_RISE). */
  slumpRise: number;
  /** A landed piece's squash into rubble, ms (COLLAPSE_SQUASH_MS). */
  squashMs: number;
  /** Pancake: a falling column's largest tilt, rad
   * (COLLAPSE_PANCAKE_TILT). */
  pancakeTilt: number;
  /** × how long the settled gravel and chunks lie in the street before
   * they fade (the dressing's persistence; the rubble boxes stay until the
   * rebuild). */
  debrisLife: number;

  // --- Dust & Smoke (look) ---
  /** Share of each cloud's puffs drawn (× the quality tier's). */
  dustDensity: number;
  /** The dust sprite's opacity (dust.ts DUST_OPACITY). */
  dustOpacity: number;
  /** × how high the column and plumes climb. */
  dustRise: number;
  /** × how far the ground surge rolls down the streets. */
  dustRollOut: number;
  /** × every puff's size. */
  dustSize: number;
  /** × how long a cloud hangs (COLLAPSE_DUST_MS; the sight-blocking haze
   * follows it). */
  dustLife: number;
  /** The whole cloud never covers more than this share of the frame
   * (dust.ts DUST_COVERAGE_MAX). */
  dustCoverageMax: number;

  // --- Fire & Sparks (look) ---
  /** Gravel trail emissions per second per collapse (TRAIL_RATE). */
  trailRate: number;
  /** A floor event's gravel / dust / glass burst, particles (BURST). */
  gravelBurst: number;
  dustBurst: number;
  glassBurst: number;
  /** × the sparks off the steel and the crush front. */
  sparkAmount: number;
  /** × the embers and fire bursting out of a failing floor. */
  floorFire: number;
  /** A crush-front burst's chance of fire (FIRE_CHANCE). */
  fireChance: number;
  /** Dying lights: the share of a broken floor's lit rooms whose lights
   * are failing — half of them dead, half stuttering (0: all steady). */
  roomFlicker: number;
  /** …and of a blue-white electrical flash (FLASH_CHANCE). */
  flashChance: number;

  // --- Chain reactions (server) ---
  /** A debris impact's blast damage at the centre (CHAIN_BLAST_DAMAGE). */
  chainBlastDamage: number;
  /** …and its radius, m (CHAIN_BLAST_RADIUS). */
  chainBlastRadius: number;
  /** The impact energy's clamp, × the blast (CHAIN_ENERGY_MIN / MAX). */
  chainEnergyMin: number;
  chainEnergyMax: number;
  /** The energy that scores 1.0, √(m³ · m²/s²) (CHAIN_ENERGY_REF): lower
   * = every impact hits harder. */
  chainEnergyRef: number;
  /** Impacts per struck building / per collapse, at most
   * (CHAIN_IMPACTS_PER_BUILDING / CHAIN_IMPACTS_MAX). */
  chainImpactsPerBuilding: number;
  chainImpactsMax: number;
  /** Links a chain may run (CHAIN_DEPTH_MAX). */
  chainDepthMax: number;

  // --- Performance (look) ---
  /** Collapses further than this shed no particles, m (DETAIL_RANGE_M):
   * the dressing's LOD distance. */
  detailRange: number;
  /** At most this many collapses shed at once (COLLAPSES_NEAR). */
  collapsesNear: number;
  /** Particles a second all collapses may spray (RATE_MAX). */
  particleBudget: number;
  /** Dust clouds drawn at once, newest first (MAX_CLOUDS). */
  dustClouds: number;
}

export type DestructionKey = keyof DestructionTuning;

/** Today's game, exactly. Frozen: the lab works on a copy. */
export const DEFAULT_DESTRUCTION_TUNING: Readonly<DestructionTuning> =
  Object.freeze({
    gravity: COLLAPSE_GRAVITY,
    crushG: COLLAPSE_CRUSH_G,
    leadMs: COLLAPSE_LEAD_MS,
    creepMs: COLLAPSE_CREEP_MS,
    toppleK: COLLAPSE_TOPPLE_K,
    toppleBreak: COLLAPSE_TOPPLE_BREAK,
    toppleBreakTop: COLLAPSE_TOPPLE_BREAK_TOP,
    toppleDrift: COLLAPSE_TOPPLE_DRIFT,
    bandMin: COLLAPSE_BAND_MIN,
    symmetry: COLLAPSE_SYMMETRY,

    slabStorey: COLLAPSE_SLAB_STOREY,
    slabGrowth: 0,
    sheetShare: COLLAPSE_SHEET_SHARE,
    sheetBreak: COLLAPSE_SHEET_BREAK,
    sheetDrift: COLLAPSE_SHEET_DRIFT,
    columnShare: COLLAPSE_COLUMN_SHARE,
    columnLean: COLLAPSE_COLUMN_LEAN,
    columnRubble: COLLAPSE_COLUMN_RUBBLE,
    rubbleRatio: COLLAPSE_RUBBLE_RATIO,
    slumpMax: COLLAPSE_SLUMP_MAX,
    slumpRise: COLLAPSE_SLUMP_RISE,
    squashMs: COLLAPSE_SQUASH_MS,
    pancakeTilt: COLLAPSE_PANCAKE_TILT,
    debrisLife: 1,

    dustDensity: 1,
    dustOpacity: LOOK_DEFAULTS.dustOpacity,
    dustRise: 1,
    dustRollOut: 1,
    dustSize: 1,
    dustLife: 1,
    dustCoverageMax: LOOK_DEFAULTS.dustCoverageMax,

    trailRate: LOOK_DEFAULTS.trailRate,
    gravelBurst: LOOK_DEFAULTS.gravelBurst,
    dustBurst: LOOK_DEFAULTS.dustBurst,
    glassBurst: LOOK_DEFAULTS.glassBurst,
    sparkAmount: 1,
    floorFire: 1,
    fireChance: LOOK_DEFAULTS.fireChance,
    roomFlicker: 0,
    flashChance: LOOK_DEFAULTS.flashChance,

    chainBlastDamage: CHAIN_BLAST_DAMAGE,
    chainBlastRadius: CHAIN_BLAST_RADIUS,
    chainEnergyMin: CHAIN_ENERGY_MIN,
    chainEnergyMax: CHAIN_ENERGY_MAX,
    chainEnergyRef: CHAIN_ENERGY_REF,
    chainImpactsPerBuilding: CHAIN_IMPACTS_PER_BUILDING,
    chainImpactsMax: CHAIN_IMPACTS_MAX,
    chainDepthMax: CHAIN_DEPTH_MAX,

    detailRange: LOOK_DEFAULTS.detailRange,
    collapsesNear: LOOK_DEFAULTS.collapsesNear,
    particleBudget: LOOK_DEFAULTS.particleBudget,
    dustClouds: LOOK_DEFAULTS.dustClouds,
  });

// --- The spec: one row per field -----------------------------------------------

export const DESTRUCTION_GROUPS = [
  "Structure",
  "Debris",
  "Dust & Smoke",
  "Fire & Sparks",
  "Chain reactions",
  "Performance",
] as const;
export type DestructionGroup = (typeof DESTRUCTION_GROUPS)[number];

/** Who reads a field: the debris builder (both sides, from the wire), the
 * server's planner and chain blasts, or the client's dressing. */
export type DestructionScope = "build" | "server" | "look";

export interface DestructionSpec {
  key: DestructionKey;
  group: DestructionGroup;
  scope: DestructionScope;
  label: string;
  /** One line of plain English: what moving it does. */
  hint: string;
  /** Range and step in STORED units (rad for angles). */
  min: number;
  max: number;
  step: number;
  /** Display unit, and stored → display factor (default 1). */
  unit: string;
  scale?: number;
  /** Whole numbers only. */
  int?: true;
}

const num = (
  key: DestructionKey,
  group: DestructionGroup,
  scope: DestructionScope,
  label: string,
  hint: string,
  min: number,
  max: number,
  step: number,
  unit = "",
): DestructionSpec => ({
  key,
  group,
  scope,
  label,
  hint,
  min,
  max,
  step,
  unit,
});

const deg = (
  key: DestructionKey,
  group: DestructionGroup,
  scope: DestructionScope,
  label: string,
  hint: string,
  min: number,
  max: number,
  step: number,
): DestructionSpec => ({
  key,
  group,
  scope,
  label,
  hint,
  min: min * DEG,
  max: max * DEG,
  step: step * DEG,
  unit: "°",
  scale: 1 / DEG,
});

const int = (
  key: DestructionKey,
  group: DestructionGroup,
  scope: DestructionScope,
  label: string,
  hint: string,
  min: number,
  max: number,
  unit = "",
): DestructionSpec => ({
  key,
  group,
  scope,
  label,
  hint,
  min,
  max,
  step: 1,
  unit,
  int: true,
});

// biome-ignore format: one row per field reads as the table it is
export const DESTRUCTION_SPEC: readonly DestructionSpec[] = [
  // Structure
  num("gravity", "Structure", "build", "Collapse speed (gravity)", "How hard debris falls — higher is a faster, more violent collapse.", 4, 25, 0.1, "m/s²"),
  num("crushG", "Structure", "build", "Crush-front pull", "How quickly a pancake's floors give way one after another (share of gravity).", 0.3, 1, 0.01, "×g"),
  num("leadMs", "Structure", "build", "Warning beat", "The rumble before anything moves.", 0, 2500, 50, "ms"),
  num("creepMs", "Structure", "build", "Failure creep", "How long the failing floor groans and sags before the block above lets go.", 0, 4000, 50, "ms"),
  num("toppleK", "Structure", "build", "Topple swing", "How fast a toppling tower swings over its base.", 0.3, 4, 0.05, "×"),
  deg("toppleBreak", "Structure", "build", "Topple base break-up", "How far the base tips before it comes apart.", 15, 80, 1),
  deg("toppleBreakTop", "Structure", "build", "Topple top break-up", "How far the top tips before it snaps off (lower = it breaks up sooner).", 5, 80, 1),
  num("toppleDrift", "Structure", "build", "Topple throw", "How much of the swing's speed the chunks keep when they break off (higher = thrown further).", 0, 1, 0.01, "×"),
  num("bandMin", "Structure", "server", "Floor strength", "A floor with less than this share of its chunks left fails and drops everything above it.", 0.2, 0.9, 0.01, "×"),
  num("symmetry", "Structure", "server", "Pancake vs topple", "How off-centre the surviving supports may be before the tower topples instead of pancaking.", 0, 0.5, 0.01, "×"),
  // Debris
  num("slabStorey", "Debris", "build", "Slab size", "Each chunk breaks into storey slabs this tall — smaller means more, smaller fragments.", 2, 12, 0.5, "m"),
  num("slabGrowth", "Debris", "build", "Bigger slabs on tall towers", "Taller towers break into bigger slabs (0 = every tower alike).", 0, 1.5, 0.05, "×"),
  num("sheetShare", "Debris", "build", "Facade peel", "Chance an outside chunk sheds a facade sheet that peels off into the street.", 0, 1, 0.01),
  deg("sheetBreak", "Debris", "build", "Facade tear-off angle", "How far a facade sheet leans out before it tears off.", 5, 70, 1),
  num("sheetDrift", "Debris", "build", "Facade throw", "How far a torn-off facade sheet carries into the street.", 0, 1, 0.01, "×"),
  num("columnShare", "Debris", "build", "Steel & rebar", "Chance a chunk carries a column / I-beam — the twisted steel left in the pile.", 0, 1, 0.01),
  deg("columnLean", "Debris", "build", "Steel lean", "How far the steel stubs lean out of the rubble.", 0, 60, 1),
  num("columnRubble", "Debris", "build", "Steel stub height", "Share of its height a column keeps standing in the pile.", 0.2, 1, 0.01, "×"),
  num("rubbleRatio", "Debris", "build", "Rubble height", "A landed slab squashes to this share of its height — the mound's height.", 0.05, 0.4, 0.01, "×"),
  deg("slumpMax", "Debris", "build", "Rubble slump", "How askew rubble settles.", 0, 35, 0.5),
  num("slumpRise", "Debris", "build", "Rubble edge rise", "How far a slumped slab's edge lifts off the pile.", 0, 4, 0.1, "m"),
  num("squashMs", "Debris", "build", "Settle time", "How long a landed piece takes to squash into rubble.", 100, 1500, 25, "ms"),
  deg("pancakeTilt", "Debris", "build", "Falling tilt", "How far pieces tip as a pancake's column drops.", 0, 40, 0.5),
  num("debrisLife", "Debris", "look", "Fragment persistence", "How long the gravel and chunks lie in the street before they fade.", 0.2, 4, 0.05, "×"),
  // Dust & Smoke
  num("dustDensity", "Dust & Smoke", "look", "Dust density", "Share of each cloud's puffs drawn (on top of the quality tier).", 0.1, 1, 0.05, "×"),
  num("dustOpacity", "Dust & Smoke", "look", "Dust opacity", "How thick each puff of dust looks.", 0.1, 1, 0.01),
  num("dustRise", "Dust & Smoke", "look", "Dust rise", "How high the dust column and plumes climb.", 0.3, 2.5, 0.05, "×"),
  num("dustRollOut", "Dust & Smoke", "look", "Dust roll-out", "How far the ground surge rolls down the streets.", 0.3, 2.5, 0.05, "×"),
  num("dustSize", "Dust & Smoke", "look", "Puff size", "How big each puff of dust is.", 0.5, 2, 0.05, "×"),
  num("dustLife", "Dust & Smoke", "look", "Dust hang time", "How long a cloud hangs in the canyon (the haze you can't see through follows it).", 0.3, 2, 0.05, "×"),
  num("dustCoverageMax", "Dust & Smoke", "look", "Screen-coverage cap", "The dust never covers more than this share of the screen — no white-outs.", 0.2, 1, 0.01),
  // Fire & Sparks
  num("trailRate", "Fire & Sparks", "look", "Gravel trail", "Gravel and chunks shed by falling pieces, per second per collapse.", 0, 150, 1, "/s"),
  num("gravelBurst", "Fire & Sparks", "look", "Gravel burst", "Gravel thrown out each time a floor fails or debris lands.", 0, 100, 1),
  num("dustBurst", "Fire & Sparks", "look", "Dust burst", "Dust puffs in the same bursts.", 0, 40, 1),
  num("glassBurst", "Fire & Sparks", "look", "Glass shards", "Glass shards blown out of a failing floor.", 0, 120, 1),
  num("sparkAmount", "Fire & Sparks", "look", "Steel sparks", "Sparks off the steel and the crush front.", 0, 3, 0.05, "×"),
  num("floorFire", "Fire & Sparks", "look", "Floor fire", "Embers and flame bursting out of each failing floor.", 0, 3, 0.05, "×"),
  num("fireChance", "Fire & Sparks", "look", "Fire on impact", "Chance a crush-front burst catches fire.", 0, 1, 0.01),
  num("roomFlicker", "Fire & Sparks", "look", "Dying lights", "Share of the lit rooms on a broken floor whose lights stutter or have died (0 = all steady).", 0, 1, 0.01),
  num("flashChance", "Fire & Sparks", "look", "Electrical flashes", "Chance a burst flashes blue-white (severed cables).", 0, 1, 0.01),
  // Chain reactions
  num("chainBlastDamage", "Chain reactions", "server", "Impact damage", "How much falling debris smashes the buildings it hits.", 0, 600, 5),
  num("chainBlastRadius", "Chain reactions", "server", "Impact radius", "How wide each debris impact bites into a neighbour.", 2, 30, 0.5, "m"),
  num("chainEnergyMin", "Chain reactions", "server", "Weakest impact", "A slow chip's impact, as a share of a full one.", 0, 1.5, 0.05, "×"),
  num("chainEnergyMax", "Chain reactions", "server", "Strongest impact", "A big slab at speed, as a share of a full one.", 0.5, 4, 0.05, "×"),
  num("chainEnergyRef", "Chain reactions", "server", "Impact energy scale", "The impact energy that counts as a full hit — lower makes every impact hit harder.", 200, 5000, 50),
  int("chainImpactsPerBuilding", "Chain reactions", "server", "Hits per neighbour", "Most impacts one collapse lands on one neighbour.", 0, 12),
  int("chainImpactsMax", "Chain reactions", "server", "Hits per collapse", "Most impacts one collapse lands in all.", 0, 48),
  int("chainDepthMax", "Chain reactions", "server", "Chain length", "How many buildings a domino may run through (0 = debris breaks nothing).", 0, 8),
  // Performance
  num("detailRange", "Performance", "look", "Detail range", "Collapses further than this shed no particles (the dressing's LOD distance).", 150, 1200, 10, "m"),
  int("collapsesNear", "Performance", "look", "Detailed collapses", "At most this many collapses shed particles at once (the nearest).", 1, 8),
  num("particleBudget", "Performance", "look", "Particle budget", "Particles per second all collapses together may spray.", 100, 2000, 10, "/s"),
  int("dustClouds", "Performance", "look", "Dust clouds", "Dust clouds drawn at once (the newest).", 1, LOOK_DEFAULTS.dustClouds),
];

const SPEC_BY_KEY = new Map(DESTRUCTION_SPEC.map((s) => [s.key, s]));

/** The spec row for `key`. Every DestructionTuning field has one. */
export function destructionSpec(key: DestructionKey): DestructionSpec {
  return SPEC_BY_KEY.get(key) as DestructionSpec;
}

/** The BUILD keys, in spec order: what a lab wire carries. */
export const BUILD_KEYS: readonly DestructionKey[] = DESTRUCTION_SPEC.filter(
  (s) => s.scope === "build",
).map((s) => s.key);

// --- Presets -------------------------------------------------------------------

export interface DestructionPreset {
  id: string;
  name: string;
  hint: string;
  /** What differs from DEFAULT_DESTRUCTION_TUNING. */
  values: Partial<DestructionTuning>;
}

export const DESTRUCTION_PRESETS: readonly DestructionPreset[] = [
  {
    id: "default",
    name: "Current default",
    hint: "The game as it ships today.",
    values: {},
  },
  {
    id: "cinematic",
    name: "Cinematic",
    hint: "Slower, bigger, louder: a long creep, huge dust, fire and sparks, more chain reactions.",
    values: {
      gravity: 8.2,
      crushG: 0.62,
      leadMs: 900,
      creepMs: 1600,
      toppleK: 1.2,
      sheetShare: 0.55,
      columnShare: 0.4,
      slabStorey: 3.5,
      dustRise: 1.4,
      dustRollOut: 1.35,
      dustSize: 1.2,
      dustLife: 1.25,
      dustCoverageMax: 0.75,
      debrisLife: 1.5,
      trailRate: 70,
      gravelBurst: 40,
      glassBurst: 56,
      sparkAmount: 1.6,
      floorFire: 1.8,
      fireChance: 0.8,
      flashChance: 0.3,
      roomFlicker: 0.6,
      chainBlastDamage: 300,
      chainEnergyMax: 2,
      collapsesNear: 4,
      particleBudget: 900,
    },
  },
  {
    id: "realistic",
    name: "Realistic",
    hint: "Real-world timing: true gravity, floors failing fast, steel-heavy rubble, grey dust that hangs.",
    values: {
      crushG: 0.82,
      creepMs: 1200,
      slabGrowth: 0.35,
      debrisLife: 1.8,
      toppleDrift: 0.35,
      slabStorey: 3.5,
      sheetShare: 0.45,
      columnShare: 0.45,
      columnLean: 0.45,
      rubbleRatio: 0.15,
      dustOpacity: 0.85,
      dustRollOut: 1.5,
      dustLife: 1.4,
      dustRise: 1.15,
      fireChance: 0.35,
      flashChance: 0.2,
      roomFlicker: 0.45,
      glassBurst: 44,
      sparkAmount: 1.3,
    },
  },
  {
    id: "performance",
    name: "Performance (phone)",
    hint: "Every solid piece unchanged, the dressing trimmed: fewer puffs, particles and clouds.",
    values: {
      dustDensity: 0.5,
      trailRate: 20,
      gravelBurst: 14,
      dustBurst: 5,
      glassBurst: 16,
      sparkAmount: 0.6,
      detailRange: 400,
      collapsesNear: 2,
      particleBudget: 300,
      dustClouds: 3,
    },
  },
];

/** DEFAULT_DESTRUCTION_TUNING with a preset's values on top (a fresh,
 * mutable copy). */
export function presetDestructionTuning(
  preset: DestructionPreset,
): DestructionTuning {
  return sanitizeDestructionTuning(preset.values);
}

// --- Clamping, export and import ----------------------------------------------

/** `v` into the field's range (whole numbers snap). Non-finite → default. */
function clampField(key: DestructionKey, v: unknown): number {
  const d = DEFAULT_DESTRUCTION_TUNING[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return d;
  const s = destructionSpec(key);
  const c = Math.min(s.max, Math.max(s.min, v));
  return s.int ? Math.round(c) : c;
}

/**
 * Any value (parsed JSON, a partial preset, a wire message, a stamped wire's
 * `dt`) → a valid DestructionTuning: the defaults with every known, finite
 * field clamped into its range on top. Unknown keys and non-numbers are
 * dropped. Cross-field rules: chainEnergyMax ≥ chainEnergyMin, and the
 * topple's top never breaks later than its base.
 */
export function sanitizeDestructionTuning(raw: unknown): DestructionTuning {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const t = { ...DEFAULT_DESTRUCTION_TUNING } as DestructionTuning;
  for (const s of DESTRUCTION_SPEC) {
    if (Object.hasOwn(o, s.key)) t[s.key] = clampField(s.key, o[s.key]);
  }
  t.chainEnergyMax = Math.max(t.chainEnergyMax, t.chainEnergyMin);
  t.toppleBreakTop = Math.min(t.toppleBreakTop, t.toppleBreak);
  return t;
}

/** The fields of `t` that differ from the defaults (all of them, or one
 * scope's). */
export function destructionDiff(
  t: Readonly<DestructionTuning>,
  scope?: DestructionScope,
): Partial<DestructionTuning> {
  const out: Partial<DestructionTuning> = {};
  for (const s of DESTRUCTION_SPEC) {
    if (scope !== undefined && s.scope !== scope) continue;
    if (t[s.key] !== DEFAULT_DESTRUCTION_TUNING[s.key]) out[s.key] = t[s.key];
  }
  return out;
}

/** Is `t` the defaults on every field (of one scope, if given)? */
export function isDefaultDestruction(
  t: Readonly<DestructionTuning>,
  scope?: DestructionScope,
): boolean {
  return Object.keys(destructionDiff(t, scope)).length === 0;
}

/** What "Copy settings" puts on the clipboard: compact JSON, version +
 * diff (`d` marks it a Destruction Lab export, not a Flight Lab one). */
export function exportDestructionTuning(
  t: Readonly<DestructionTuning>,
): string {
  return JSON.stringify({
    v: DESTRUCTION_TUNING_VERSION,
    d: destructionDiff(t),
  });
}

export type DestructionImport =
  | { ok: true; tuning: DestructionTuning }
  | { ok: false; error: string };

/** The decoded object of an export → a valid DestructionTuning, or why not. */
export function importDestructionObject(raw: unknown): DestructionImport {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "not a Destruction Lab export" };
  }
  const { v, d } = raw as { v?: unknown; d?: unknown };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: "missing version" };
  }
  if (v > DESTRUCTION_TUNING_VERSION) {
    return { ok: false, error: `made by a newer Destruction Lab (v${v})` };
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    return { ok: false, error: "no settings in it" };
  }
  return { ok: true, tuning: sanitizeDestructionTuning(d) };
}

/** A pasted export (JSON text) → a valid DestructionTuning, or why not. */
export function importDestructionTuning(text: string): DestructionImport {
  try {
    return importDestructionObject(JSON.parse(text));
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
}

/** The `?destructlab=` value for `t`: the export, base64url. */
export function encodeDestructionShare(t: Readonly<DestructionTuning>): string {
  return b64
    .btoa(exportDestructionTuning(t))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A `?destructlab=` value → a valid DestructionTuning, or why not. */
export function decodeDestructionShare(code: string): DestructionImport {
  try {
    const s = code.replace(/-/g, "+").replace(/_/g, "/");
    return importDestructionTuning(
      b64.atob(s + "=".repeat((4 - (s.length % 4)) % 4)),
    );
  } catch {
    return { ok: false, error: "broken share link" };
  }
}

// --- The lab wire's build tuning ----------------------------------------------

/** What a Destruction Lab room stamps on a collapse wire (`dt`): the BUILD
 * fields that differ from the defaults, or undefined when none do (a wire
 * built on the defaults carries nothing). */
export function buildStamp(
  t: Readonly<DestructionTuning>,
): Partial<DestructionTuning> | undefined {
  const d = destructionDiff(t, "build");
  return Object.keys(d).length > 0 ? d : undefined;
}

let stampText = "";
let stampTuning: Readonly<DestructionTuning> = DEFAULT_DESTRUCTION_TUNING;

/** A stamped wire's `dt` → the tuning its debris is built with (clamped;
 * the defaults for anything not BUILD). The last one is cached — a lab
 * stamps the same diff on every wire until a slider moves. */
export function tuningFromStamp(dt: unknown): Readonly<DestructionTuning> {
  if (!dt || typeof dt !== "object") return DEFAULT_DESTRUCTION_TUNING;
  const text = JSON.stringify(dt);
  if (text !== stampText) {
    const raw = dt as Record<string, unknown>;
    const only: Record<string, unknown> = {};
    for (const k of BUILD_KEYS) if (Object.hasOwn(raw, k)) only[k] = raw[k];
    stampTuning = Object.freeze(sanitizeDestructionTuning(only));
    stampText = text;
  }
  return stampTuning;
}

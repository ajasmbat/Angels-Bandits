// Graphics quality tiers (O3). One table says what every Living City feature
// does on High, Medium, Low and Mobile (M3); main.ts hands the chosen tier to each
// module's `setQuality` and caps the adaptive resolution scaler with it.
//
// Two rules every tier obeys, and the reason the table is shaped like this:
//
//  1. A tier switch never compiles a shader. Tiers only flip `.visible`,
//     instance/draw counts and uniforms — never a material, a `#define` or
//     an object added to the scene later. O2 pre-warms every program at
//     boot, so a switch mid-fight costs nothing, and Auto can step down
//     without the very hitch it is stepping down to avoid.
//  2. Visibility parity. Fog, haze, the storm (bolts, flash, reveals), the
//     cloud deck and every SOLID thing (buildings, movers, the train and its
//     viaduct, bridges, boats, trees) are identical on every tier, so a Low
//     player never sees further or through anything a High player cannot.
//     Rain streaks are near-field dressing; the weather's haze is the
//     visibility mechanism and it does not change.
//
// The resolution scaler (resolution.ts) stays the first line of defence: it
// trades pixels for frame time within a tier's ceiling. The Auto tier logic
// sits ABOVE it and only acts once the scaler has already given up most of
// its pixels and frames still miss — then it trades features instead.
//
// M3 Mobile: a fourth tier for phones, the cheapest on every knob. Its pixel
// ceiling is 1, like Low's: 1.25 was measured first, and on the runner's
// phone proxy it left Mobile only 2.8x cheaper than High on draw calls ×
// pixels (the draw count barely moves between tiers), short of the 3x M3
// asks for; 1 clears it. It steers to 30 fps rather than 60 —
// see MOBILE_FRAME_BUDGET_MS — and Auto starts there on a coarse-pointer
// device, where the thermal step-down (bottom of this file) replaces the
// desktop tier drops.

import {
  FRAME_BUDGET_MS,
  MISS_MS,
  MISS_SHARE,
  type ResolutionLimits,
  defaultLimits,
} from "./resolution";

export type QualityTier = "high" | "medium" | "low" | "mobile";
/** What the player picks: a fixed tier, or Auto (starts High, steps down). */
export type QualitySetting = "auto" | QualityTier;

/** The G key and the HUD entry cycle through these, in this order. Mobile
 * is last, and is a legitimate pick on any device (a weak laptop too). */
export const QUALITY_SETTINGS: readonly QualitySetting[] = [
  "auto",
  "high",
  "medium",
  "low",
  "mobile",
];
/** What ships: Auto. On a machine that holds 60 fps it never leaves High. */
export const DEFAULT_QUALITY: QualitySetting = "auto";
/** Cycles the setting (the HUD entry does the same on click). */
export const QUALITY_KEY = "KeyG";
/** localStorage key for the player's pick (a `?quality=` URL wins over it). */
export const QUALITY_STORAGE_KEY = "ab-quality";

/** Per-tier knobs. 1 = full, 0 = off, in between = reduced. */
export interface QualityProfile {
  /** Ceiling on the adaptive pixel ratio (the panel's own ceiling still applies). */
  maxPixelRatio: number;
  /** L4 rain streaks drawn, share of the full count. */
  rainDensity: number;
  /** L1 micro tier: share of pedestrians kept (scales the altitude gate's thinning). */
  crowdDensity: number;
  /** L1 reactive city: share of each kill-site smoke column's puffs. */
  smokeColumns: number;
  /** L3 living windows: TV flicker, silhouettes, slow on/off, cleaning crew. */
  livingWindows: boolean;
  /** L6 headlight cones (the additive volumes). The ground pools stay on. */
  headlightCones: boolean;
  /** L7 the coloured light each sign spills onto the street. */
  signSpill: boolean;
  /** L8 rooftop string lights (the party/pool props stay). */
  rooftopLights: boolean;
  /** L9 crowns sway in the shared wind. */
  treeSway: boolean;
  /** L9 fountain spray, share of particles. */
  fountains: number;
  /** L9 birds drawn per flock, share. */
  birds: number;
  /** L10 airliner contrail length, share. */
  contrails: number;
  /** L13 fire escapes, balconies, AC units, scaffolding. */
  facadeDetail: boolean;
  /** The bloom pass (half-res chain). Mobile keeps it: the lower pixel ratio
   * already makes it cheap, and a quarter-res chain would let a 1–2 px tracer
   * fall between texels and its halo shimmer. Only thermal level 1 drops it. */
  bloom: boolean;
  /** The final grade pass (vignette, saturation, split-tone). */
  grade: boolean;
  /** L1 street steam, share of each vent's puffs. */
  steamDensity: number;
  /** L1 micro tier + street detail: the block-window radius pedestrians,
   * steam, signals and construction sparks stream in (BLOCK_WINDOW_RADIUS is
   * the ceiling; their buffers stay sized for it, so this only moves counts). */
  microRadius: number;
  /** L7 sign animation (tickers, chases, video). Off = each sign's static art. */
  signAnimation: boolean;
  /** S1 the jumbotrons' LAST KILL shot (one small render pass per kill).
   * Off = the static livery card painted on the screen. */
  jumbotronReplay: boolean;
  /** Fake window interiors (the per-pane parallax room raycast). Off = the
   * room's mean colour, the same value the distance fade already ends on.
   * G1: the lit lobbies / shop rooms behind the street-level glass too. */
  windowInteriors: boolean;
  /** A1 city life: share of the new figures kept (riders, crossers, groups,
   * stations, balcony and terrace people). Instance counts only. */
  cityLife: number;
  /** A1 facade life: laundry lines, facade flags and banners, pigeons. */
  facadeLife: boolean;
  /** G1 street furniture + parked cars: share of objects kept (golden-ratio
   * thinning by a uniform — street-furniture.ts). */
  streetDetail: number;
  /** G1 fine ground paint (wear, patches, manholes, drains, arrows, words,
   * bike lanes, ramps, tiles, grates). Off = the S1/VO5 paint alone. */
  streetPaint: boolean;
  /** H2 hole interiors (murals, signs, fans, trays, lane paint, lobby
   * glass): 1 drawn, 0 folded away by a uniform. The approach chevrons and
   * the tunnel's LED strips are guidance and stay on every tier. */
  holeDecor: number;
  /** R2 roof dressing's fine detail (drains, hatches, walkways, lightning
   * rods, dishes, braces, gondola cables). Structures are solid and stay. */
  roofDetail: boolean;
  /** S3 the record ghost replayed beside a course run (one translucent
   * draw). The rings themselves are guidance and stay on every tier. */
  courseGhost: boolean;
  /** D1 bullet impacts: share of the full budget — impact particles
   * (1200 × share), facade damage slots (16 + 32 × share) and burning
   * patches (2 + 4 × share). Counts only; the shaders never change. */
  impacts: number;
  /** X1 missile impacts: share of the debris throw (sparks, dust, chunks).
   * The missile, its glint and smoke trail — the telegraph — and the blast
   * itself are identical on every tier. */
  missileDebris: number;
  /** D2 broken-edge detail: rebar and jagged-edge noise on the faces
   * destruction exposed. Off = flat concrete slabs and dark rooms, by a
   * uniform. The broken geometry itself is solid and identical everywhere. */
  destructionDetail: boolean;
  /** D3 collapse dust: share of each cloud's puffs (sprites grow to cover
   * the same air). The sight-blocking haze and the debris itself — solid —
   * are identical on every tier. */
  collapseDust: number;
  /** D4 falling wrecks: share of the flames and smoke their trail and their
   * landing fire emit (into the D1 particle pool). The wreck itself, its
   * explosion and the street scorch are on every tier — the wreck is solid. */
  wreckFire: number;
  /** D5 director warnings and rebuilds: share of the dust spilling from a
   * warned tower, a gas main's steam, a crane's sparks, the welders and the
   * rebuild's pop (into the D1 pool). The warning's sound, siren and tremor
   * — the telegraph — are identical on every tier. */
  directorFx: number;
  /** D5 rebuild dressing: how many damaged buildings near the camera wear
   * scaffolding and a rebuild crane at once (cosmetic, never solid). */
  scaffold: number;
  /** S7 kill-streak smoke: share of its puff emission rate (the trail
   * thins, never shortens). Cosmetic — the streak is on the scoreboard too. */
  streakSmoke: number;
  /** S4 sky boss: share of the particle dressing — the flak bursts' flames
   * and smoke, and the falling sections' fire trails and landing fires. The
   * zeppelin (solid), its weak points, running lights and the flak shells
   * themselves (the telegraph) are identical on every tier. */
  bossFx: number;
  /** S5 wind litter: share of each block's scraps kept (stride thinning). */
  litter: number;
  /** S5 moon light shafts (the quarter-res ShaftsPass; off skips it). */
  lightShafts: boolean;
  /** S5 heat shimmer over roof exhaust stacks (a FinalPass uniform). */
  heatShimmer: boolean;
  /** S5 lens flares and streaks on the brightest lights (a FinalPass uniform). */
  glare: boolean;
  /** U4 tunnel light fixtures (ceiling strips, guide lights, portal kerb
   * lights, river mouth frames): one draw. The concrete shell is solid and
   * identical on every tier, and carries its own baked light, so a tunnel
   * stays lit without them. */
  tunnelFixtures: boolean;
  /** U5 underground life: how many of the dressing's bands are drawn —
   * 3 = core + detail + fine, 1 = core only (the metro hall, its glass,
   * the panels, the waterfalls, the lake). A drawRange prefix on four
   * draws; the shell and the hall's glass are identical on every tier. */
  tunnelLife: number;
  /** S6 glass reflections: cube-probe faces re-rendered per frame (at most
   * 1; a full refresh every 6 / share frames). 0 = off: no probe renders,
   * and glass, puddles and the river keep their faked reflections. */
  reflections: number;
}

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> = {
  high: {
    maxPixelRatio: 2,
    rainDensity: 1,
    crowdDensity: 1,
    smokeColumns: 1,
    livingWindows: true,
    headlightCones: true,
    signSpill: true,
    rooftopLights: true,
    treeSway: true,
    fountains: 1,
    birds: 1,
    contrails: 1,
    facadeDetail: true,
    bloom: true,
    grade: true,
    steamDensity: 1,
    microRadius: 2,
    signAnimation: true,
    jumbotronReplay: true,
    windowInteriors: true,
    cityLife: 1,
    facadeLife: true,
    streetDetail: 1,
    streetPaint: true,
    holeDecor: 1,
    roofDetail: true,
    courseGhost: true,
    impacts: 1,
    missileDebris: 1,
    destructionDetail: true,
    collapseDust: 1,
    wreckFire: 1,
    directorFx: 1,
    scaffold: 8,
    streakSmoke: 1,
    bossFx: 1,
    litter: 1,
    lightShafts: true,
    heatShimmer: true,
    glare: true,
    tunnelFixtures: true,
    tunnelLife: 3,
    reflections: 1,
  },
  medium: {
    maxPixelRatio: 1.5,
    rainDensity: 0.5,
    crowdDensity: 0.7,
    smokeColumns: 1,
    livingWindows: true,
    headlightCones: true,
    signSpill: true,
    rooftopLights: true,
    treeSway: true,
    fountains: 0.5,
    birds: 1,
    contrails: 1,
    facadeDetail: true,
    bloom: true,
    grade: true,
    steamDensity: 1,
    microRadius: 2,
    signAnimation: true,
    jumbotronReplay: true,
    windowInteriors: true,
    cityLife: 0.7,
    facadeLife: true,
    streetDetail: 1,
    streetPaint: true,
    holeDecor: 1,
    roofDetail: true,
    courseGhost: true,
    impacts: 0.75,
    missileDebris: 0.75,
    destructionDetail: true,
    collapseDust: 0.75,
    wreckFire: 0.75,
    directorFx: 0.75,
    scaffold: 6,
    streakSmoke: 1,
    bossFx: 0.75,
    litter: 1,
    lightShafts: true,
    heatShimmer: true,
    glare: true,
    tunnelFixtures: true,
    tunnelLife: 3,
    reflections: 0.5,
  },
  low: {
    maxPixelRatio: 1,
    rainDensity: 0.35,
    crowdDensity: 0.4,
    smokeColumns: 0.5,
    livingWindows: false,
    headlightCones: false,
    signSpill: false,
    rooftopLights: false,
    treeSway: false,
    fountains: 0,
    birds: 0.5,
    contrails: 0.5,
    facadeDetail: false,
    bloom: true,
    grade: true,
    steamDensity: 1,
    microRadius: 2,
    signAnimation: true,
    jumbotronReplay: true,
    windowInteriors: true,
    cityLife: 0.45,
    facadeLife: false,
    streetDetail: 0.7,
    streetPaint: true,
    holeDecor: 1,
    roofDetail: false,
    courseGhost: true,
    impacts: 0.5,
    missileDebris: 0.5,
    destructionDetail: false,
    collapseDust: 0.5,
    wreckFire: 0.5,
    directorFx: 0.5,
    scaffold: 4,
    streakSmoke: 0.5,
    bossFx: 0.5,
    litter: 0.5,
    lightShafts: true,
    heatShimmer: true,
    glare: true,
    tunnelFixtures: true,
    tunnelLife: 2,
    reflections: 0.34,
  },
  mobile: {
    maxPixelRatio: 1,
    rainDensity: 0.25,
    crowdDensity: 0.3,
    smokeColumns: 0.34,
    livingWindows: false,
    headlightCones: false,
    signSpill: false,
    rooftopLights: false,
    treeSway: false,
    fountains: 0,
    birds: 0.5,
    contrails: 0.5,
    facadeDetail: false,
    bloom: true,
    grade: false,
    steamDensity: 0.5,
    microRadius: 1,
    signAnimation: false,
    jumbotronReplay: false,
    windowInteriors: false,
    cityLife: 0.3,
    facadeLife: false,
    streetDetail: 0.4,
    streetPaint: false,
    holeDecor: 0,
    roofDetail: false,
    courseGhost: false,
    impacts: 0.25,
    missileDebris: 0.3,
    destructionDetail: false,
    collapseDust: 0.3,
    wreckFire: 0.35,
    directorFx: 0.35,
    scaffold: 2,
    streakSmoke: 0.5,
    bossFx: 0.35,
    litter: 0.34,
    lightShafts: false,
    heatShimmer: false,
    glare: false,
    tunnelFixtures: false,
    tunnelLife: 1,
    reflections: 0,
  },
};

type Behaviour = "full" | "reduced" | "off";

/**
 * Every Living City feature, per tier — the contract the PR and README
 * quote. Features that are "full" on every tier say why: they are solid
 * (the crash check and the camera arm collide with them), audio, or cost
 * nothing on the GPU worth trading.
 */
export const FEATURE_TIERS: readonly {
  feature: string;
  high: Behaviour;
  medium: Behaviour;
  low: Behaviour;
  mobile: Behaviour;
  note: string;
}[] = [
  {
    feature: "L1 reactive city — alarms, lit windows, responders",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "gameplay-adjacent (kill sites); CPU only",
  },
  {
    feature: "L1 reactive city — smoke columns",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "half the puffs per column (Mobile: a third)",
  },
  {
    feature: "L1 street life — pedestrians",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "70 % / 40 % / 30 % of the crowd",
  },
  {
    feature: "A1 city life — riders, crossers, groups, stations, balconies",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "70 % / 45 % / 30 % of the figures; Mobile streams one block out",
  },
  {
    feature: "A1 facade life — laundry, facade flags, pigeons",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "not solid; one baked mesh hidden",
  },
  {
    feature: "L1 street life — steam, signals, sparks",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "reduced",
    note: "already altitude-gated; Mobile streams one block out, half the steam",
  },
  {
    feature: "L2 city soundscape",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "audio, no GPU cost",
  },
  {
    feature: "L3 living windows",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "uniform guard: static window grid",
  },
  {
    feature: "L4 rain streaks",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "50 % / 35 % / 25 % of the streaks; haze unchanged",
  },
  {
    feature: "L4 wet streets, puddles",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "uniform-only",
  },
  {
    feature: "L5 elevated train + viaduct",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid",
  },
  {
    feature: "T2 trains: stations, cars, signs, doors",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid; skin is shader-only, one instanced draw",
  },
  {
    feature: "T2 platform people",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "scale-0 instances, no draw change",
  },
  {
    feature: "T2 train sparks + lights",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "sparks 50 % / off; lamps within 500 m (else fog + 100 m)",
  },
  {
    feature: "L6 traffic (cars, buses, responders)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "feeds audio and reactions; one instanced draw",
  },
  {
    feature: "L6 headlight cones",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "additive fill; the ground pools stay",
  },
  {
    feature: "L7 signage animation",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "uniform clock; Mobile: uniform guard, each sign's static art",
  },
  {
    feature: "L7 sign light spill",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "additive ground decals",
  },
  {
    feature: "S1 jumbotrons + headline tickers",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "one instanced draw; canvases repaint on events only; the ticker crawl follows L7 sign animation",
  },
  {
    feature: "S1 LAST KILL replay shot",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "one 256×144 pass per kill; Mobile: uniform flip to the static livery card",
  },
  {
    feature: "S1 leader follow spot",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "it points at the leader, so it is identical on every tier (visibility parity); a beam slot, no draw",
  },
  {
    feature: "L8 rooftop props (pools, fans, flags)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "one merged mesh",
  },
  {
    feature: "L8 rooftop string lights",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "point sprites",
  },
  {
    feature: "L9 tree sway",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "crowns hold still",
  },
  {
    feature: "L9 fountains",
    high: "full",
    medium: "reduced",
    low: "off",
    mobile: "off",
    note: "half the spray / none",
  },
  {
    feature: "L9 birds",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "half of each flock",
  },
  {
    feature: "L10 airliners",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "contrails half as long",
  },
  {
    feature: "L10 news helicopter, drone shows",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid mover / shared light cloud",
  },
  {
    feature: "L11 river, bridges, boats",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid",
  },
  {
    feature: "U4 tunnels — the concrete shell (walls, ramps, lintels)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid: the crash check, the camera arm and the bots collide with it; baked light",
  },
  {
    feature: "U4 tunnels — light fixtures (strips, guide and portal lights)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "one draw; dressing only — the shell keeps its baked light",
  },
  {
    feature:
      "U5 underground life — gardens, vines, glowing plants, fireflies, birds, station people",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "four draws; bands thinned by drawRange — the metro hall, its glass, panels, waterfalls and the lake stay on every tier",
  },
  {
    feature: "L12 sky cycle",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "uniforms only",
  },
  {
    feature: "L13 facade detail",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "not solid; dressing only",
  },
  {
    feature: "Bloom",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "half-res chain, cheaper via the pixel ceiling; off at thermal level 1",
  },
  {
    feature: "Final grade (vignette, saturation)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "one full-screen pass",
  },
  {
    feature: "H2 hole interiors — murals, signs, fans, lobby glass",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "not solid; folded by a uniform in the one baked decor mesh",
  },
  {
    feature: "H2 hole guidance — chevrons, LED strips, mouth frame",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "how a pilot finds a hole; one draw call shared with the interiors",
  },
  {
    feature: "G1 street furniture, parked cars",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "not solid; 70 % / 40 % kept (Mobile streams one block out)",
  },
  {
    feature: "G1 fine street paint (wear, manholes, words, ramps)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "uniform guard: the S1 paint alone",
  },
  {
    feature: "D2 broken edges — rebar, jagged concrete",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "uniform guard: flat slabs and dark rooms; the holes and rubble are solid on every tier",
  },
  {
    feature: "Window interiors (parallax rooms)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "uniform guard: the room's mean colour (G1 lobbies too)",
  },
  {
    feature:
      "R2 roof structures (penthouses, towers, tanks, billboards, masts)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid",
  },
  {
    feature: "S3 stunt course rings",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "guidance: one instanced draw, non-collidable",
  },
  {
    feature: "S3 course record ghost",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "one translucent draw; MOBILE keeps the rings only",
  },
  {
    feature: "R2 roof dressing — fine detail (drains, hatches, rods, dishes)",
    high: "full",
    medium: "full",
    low: "off",
    mobile: "off",
    note: "instance count only; HVAC, ducts, solar, davits, lamps stay",
  },
  {
    feature: "D3 collapse debris and rubble",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid: the crash check, the camera arm and the bots collide with every falling chunk and rubble slab",
  },
  {
    feature: "D3 collapse dust — puffs",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "40 / 30 / 20 / 12 puffs per cloud, each bigger to cover the same air; the sight-blocking haze is the same on every tier",
  },
  {
    feature: "D1 bullet impacts — sparks, dust, glass, decals, burning patches",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "1200 / 900 / 600 / 300 particles, 48 / 40 / 32 / 24 facade damage slots, 6 / 5 / 4 / 3 burns; not solid, cosmetic only",
  },
  {
    feature: "D4 falling wrecks — trail flames + smoke, landing fire",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "emission 100 / 75 / 50 / 35 %; the wreck (solid), its explosion and the street scorch stay on every tier",
  },
  {
    feature: "S7 kill-streak smoke",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "puff emission 100 / 100 / 50 / 50 %; one tinted Points draw for every streaking plane; the scoreboard glow carries the streak on every tier",
  },
  {
    feature: "S4 sky boss — the zeppelin, weak points, lights, flak shells",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "solid (crash check, camera arm, bots) and the flak's telegraph: two instanced draws + two Points on every tier",
  },
  {
    feature: "S4 sky boss — flak bursts, falling-section fire and smoke",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "reduced",
    note: "emission 100 / 75 / 50 / 35 % into the D1 particle pool (no extra draw); the bursts' damage and the sections themselves are the same everywhere",
  },
  {
    feature: "S5 fog banks (drifting haze between the towers)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "visibility parity: haze is the same on every tier; one instanced draw",
  },
  {
    feature: "S5 wind litter (paper, leaves, wrappers; low-pass kick)",
    high: "full",
    medium: "full",
    low: "reduced",
    mobile: "reduced",
    note: "half / a third of the scraps (Mobile streams one block out); one Points draw",
  },
  {
    feature: "S5 moon light shafts",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "quarter-res pass, skipped when off or the moon is out of view",
  },
  {
    feature: "S5 searchlight rays (haze striations in the beams)",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "beam shader only; no draw",
  },
  {
    feature: "S5 heat shimmer over exhaust stacks",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "FinalPass uniform; no draw",
  },
  {
    feature: "S5 glare — lens flares and streaks",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "off",
    note: "FinalPass uniform (low-res bloom taps); no draw",
  },
  {
    feature: "S5 wet-roof sign reflections",
    high: "full",
    medium: "full",
    low: "full",
    mobile: "full",
    note: "building shader, wetness uniform only",
  },
  {
    feature: "S6 glass reflections — neon skyline in glass, puddles, river",
    high: "full",
    medium: "reduced",
    low: "reduced",
    mobile: "off",
    note: "one 128 px cube probe, 1 / 0.5 / 0.34 faces per frame (a full refresh every 6 / 12 / 18 frames); off = no probe pass and the faked reflections",
  },
];

/**
 * The adaptive scaler's limits under a tier: the panel's own limits with the
 * ceiling capped at the tier's `maxPixelRatio`. A pinned `?res=` ignores
 * this on purpose — a pinned ratio is a QA instrument, and it must draw
 * exactly what it says or the harness compares two different workloads.
 */
export function qualityLimits(
  devicePixelRatio: number,
  tier: QualityTier,
  thermalLevel = 0,
): ResolutionLimits {
  const panel = defaultLimits(devicePixelRatio);
  const ceiling = Math.min(
    panel.ceiling,
    QUALITY_PROFILES[tier].maxPixelRatio,
    thermalCeiling(thermalLevel),
  );
  return { floor: Math.min(panel.floor, ceiling), ceiling };
}

/**
 * M3: the frame budget a tier steers to, ms. Mobile aims at a steady 30 fps:
 * against a 60 fps budget, iOS Low Power Mode's 30 Hz rAF cap (or any phone
 * that holds a steady 30) reads as every frame missing, and the scaler would
 * sit on its floor for good. Nothing caps a phone that does better — this
 * only moves the line the scaler and the step-downs call a miss.
 */
export const MOBILE_FRAME_BUDGET_MS = 1000 / 30;

export function tierBudgetMs(tier: QualityTier): number {
  return tier === "mobile" ? MOBILE_FRAME_BUDGET_MS : FRAME_BUDGET_MS;
}

/** The miss line under a tier's budget: the same 1.5x ratio as MISS_MS. */
export function tierMissMs(tier: QualityTier): number {
  return tierBudgetMs(tier) * (MISS_MS / FRAME_BUDGET_MS);
}

/** Whether the bloom pass runs: the tier's switch, and off from thermal
 * level 1 (the biggest post cost left on a phone once grade is off). */
export function bloomOn(tier: QualityTier, thermalLevel: number): boolean {
  return QUALITY_PROFILES[tier].bloom && thermalLevel < 1;
}

/** A `?quality=` / localStorage value, or null when absent or junk. */
export function parseQualitySetting(
  raw: string | null | undefined,
): QualitySetting | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  return (QUALITY_SETTINGS as readonly string[]).includes(v)
    ? (v as QualitySetting)
    : null;
}

/** The next setting in the G / menu cycle. */
export function nextQualitySetting(s: QualitySetting): QualitySetting {
  const i = QUALITY_SETTINGS.indexOf(s);
  return QUALITY_SETTINGS[(i + 1) % QUALITY_SETTINGS.length] as QualitySetting;
}

/** The tier one step cheaper, or null at the bottom. Desktop Auto bottoms
 * out at Low; Mobile is its own ladder, whose rungs are thermal levels. */
export function tierBelow(t: QualityTier): QualityTier | null {
  return t === "high" ? "medium" : t === "medium" ? "low" : null;
}

/**
 * Where Auto starts. A coarse PRIMARY pointer is a phone or tablet (M2's
 * touch rule, ui/mobile.ts): Mobile. A touchscreen laptop keeps a fine
 * primary pointer, so it starts at High like any desktop.
 */
export function autoStartTier(coarsePointer: boolean): QualityTier {
  return coarsePointer ? "mobile" : "high";
}

// --- Auto ------------------------------------------------------------------
//
// Auto starts at High and only ever steps DOWN. Stepping up would mean
// probing a tier we already know misses, and a feature popping back in is
// far more visible than one resolution rung; a player who wants it back
// picks a tier by hand.
//
// The evidence is the scaler's own: the share of missed frames over its
// window. But a miss only counts as PRESSURE once pixels can no longer fix
// it — either the scaler is already at or below AUTO_RATIO_GATE, or the
// frame is CPU-BOUND: the window's median JS cost BEFORE the render call
// (sim, streaming, instance packing — measured for free with
// performance.now()) is already most of the budget, so no resolution rung
// can bring it under. The render call itself is deliberately NOT timed: a
// driver may block inside it waiting on the GPU, which would make a
// GPU-bound frame read as CPU-bound — exactly backwards.
// The second test is what stops a CPU-bound machine from walking four
// useless resolution rungs before it sheds a single feature. After a drop
// main.ts keeps the scaler's current ratio but clears its latch, so the
// cheaper tier earns its pixels back rung by rung — the player does not stay
// blurry AND reduced while the latch slowly relaxes, and does not re-walk
// the rungs that just missed either.
//
// What does NOT count, because none of it is the machine's steady state:
// a hidden tab, the first frames back from one, death/respawn, a resize, a
// teleport. main.ts calls `interruptAutoQuality` on each, which restarts the
// unbroken-pressure clock. A single GC pause or alt-tab spike can never
// drop a tier: it takes AUTO_PRESSURE_MS of back-to-back bad windows.

/** The scaler ratio at or below which a miss is evidence against the tier. */
export const AUTO_RATIO_GATE = 1;
/**
 * Median pre-render JS cost, as a share of FRAME_BUDGET_MS, at or above
 * which a window is CPU-bound. Pixels do not enter that number at all, so
 * one this close to the budget cannot be rescued by drawing fewer of them.
 */
export const AUTO_CPU_BOUND = 0.8;
/** Unbroken pressure required before Auto drops a tier, ms. */
export const AUTO_PRESSURE_MS = 3000;
/** After a drop, how long the new tier is left alone to settle, ms. */
export const AUTO_SETTLE_MS = 5000;

export interface AutoQualityState {
  tier: QualityTier;
  /** Clock of the first tick of the current unbroken pressure run, or null. */
  pressureSince: number | null;
  /** Clock of the last drop (or of the start) — the settle window. */
  changedAt: number;
}

export function createAutoQuality(
  now: number,
  start: QualityTier = "high",
): AutoQualityState {
  return { tier: start, pressureSince: null, changedAt: now };
}

/** A transient (hidden tab, death, resize, teleport): forget the pressure run. */
export function interruptAutoQuality(s: AutoQualityState): AutoQualityState {
  return s.pressureSince === null ? s : { ...s, pressureSince: null };
}

/**
 * Pressure: enough of the window missed, and drawing fewer pixels can no
 * longer fix it. `budgetMs` scales the CPU-bound line with the tier's budget
 * (the caller already counted misses against that budget's miss line).
 */
export function underPressure(
  missShare: number,
  ratio: number,
  cpuMs: number,
  budgetMs: number = FRAME_BUDGET_MS,
): boolean {
  const pixelsCannotHelp =
    ratio <= AUTO_RATIO_GATE || cpuMs >= budgetMs * AUTO_CPU_BOUND;
  return missShare >= MISS_SHARE && pixelsCannotHelp;
}

/**
 * One Auto tick. `missShare` is the scaler window's share of missed frames,
 * `ratio` the scaler's current pixel ratio and `cpuMs` the window's median
 * pre-render JS cost. Compare `tier`, not object identity, to decide
 * whether anything needs re-applying.
 */
export function stepAutoQuality(
  s: AutoQualityState,
  missShare: number,
  ratio: number,
  cpuMs: number,
  now: number,
  budgetMs: number = FRAME_BUDGET_MS,
): AutoQualityState {
  if (!underPressure(missShare, ratio, cpuMs, budgetMs)) {
    return interruptAutoQuality(s);
  }
  if (now - s.changedAt < AUTO_SETTLE_MS) return interruptAutoQuality(s);
  const since = s.pressureSince ?? now;
  if (now - since < AUTO_PRESSURE_MS) {
    return s.pressureSince === null ? { ...s, pressureSince: since } : s;
  }
  const below = tierBelow(s.tier);
  if (below === null) return s;
  return { tier: below, pressureSince: null, changedAt: now };
}

// --- Thermal step-down (M3) -------------------------------------------------
//
// Auto on a phone starts at Mobile, which has no tier below it. A phone's
// steady state still changes under it, though: after a few minutes of
// sustained GPU load it throttles, and frames that held 30–60 fps start to
// miss. No browser exposes a temperature, so throttling is read by its
// SYMPTOM — the same pressure Auto uses, against Mobile's 30 fps budget:
// misses in at least MISS_SHARE of the window while pixels can no longer
// help. Pressure only counts once the scaler has given up its pixels, so the
// two controllers act in turn and never pull against each other.
//
// Each level only ever makes things cheaper and nothing ever steps back up,
// so there is no oscillation by construction. Level 1 drops bloom and caps
// the scaler at 1.0 (Mobile's own ceiling today; the cap keeps a thermal
// level meaning the same thing if that ceiling is ever raised); level 2
// caps it at 0.75 — RESOLUTION_FLOOR, so the
// scaler is pinned there on purpose. The cap is the point: without it, the
// scaler's latch relaxes every 1–8 minutes and probes straight back up into
// the heat. A reload, or picking a tier by hand, starts over at level 0.

/** Highest thermal level. */
export const THERMAL_MAX_LEVEL = 2;
/** Pixel-ratio ceiling per thermal level (level 0 adds no cap). */
export const THERMAL_CEILINGS: readonly number[] = [
  Number.POSITIVE_INFINITY,
  1,
  0.75,
];
/** Unbroken pressure before a step. Longer than Auto's 3 s: heat builds
 * over minutes, and a GC pause or a streaming burst is not heat. */
export const THERMAL_PRESSURE_MS = 10_000;
/** After a step, how long the new level is left alone to settle, ms. */
export const THERMAL_SETTLE_MS = 30_000;

/** The pixel-ratio cap a thermal level imposes. */
export function thermalCeiling(level: number): number {
  const i = Math.max(0, Math.min(THERMAL_MAX_LEVEL, Math.floor(level)));
  return THERMAL_CEILINGS[i] as number;
}

export interface ThermalState {
  level: number;
  /** Clock of the first tick of the current unbroken pressure run, or null. */
  pressureSince: number | null;
  /** Clock of the last step (or of the start) — the settle window. */
  changedAt: number;
}

export function createThermal(now: number): ThermalState {
  return { level: 0, pressureSince: null, changedAt: now };
}

/** A transient (hidden tab, death, resize, teleport): forget the pressure run. */
export function interruptThermal(s: ThermalState): ThermalState {
  return s.pressureSince === null ? s : { ...s, pressureSince: null };
}

/**
 * One thermal tick, on the scaler's cadence and window, with the same inputs
 * as `stepAutoQuality` (misses counted against Mobile's miss line). Compare
 * `level`, not object identity, to decide whether to re-apply anything.
 */
export function stepThermal(
  s: ThermalState,
  missShare: number,
  ratio: number,
  cpuMs: number,
  now: number,
  budgetMs: number = MOBILE_FRAME_BUDGET_MS,
): ThermalState {
  if (!underPressure(missShare, ratio, cpuMs, budgetMs)) {
    return interruptThermal(s);
  }
  if (now - s.changedAt < THERMAL_SETTLE_MS) return interruptThermal(s);
  const since = s.pressureSince ?? now;
  if (now - since < THERMAL_PRESSURE_MS) {
    return s.pressureSince === null ? { ...s, pressureSince: since } : s;
  }
  if (s.level >= THERMAL_MAX_LEVEL) return s;
  return { level: s.level + 1, pressureSince: null, changedAt: now };
}

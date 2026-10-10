// FL1 Flight Lab — every flight and controls tunable as ONE typed object.
//
// `DEFAULT_TUNING` is today's game, value for value: the physics half is
// built from the very constants.ts names it mirrors, and the client-only
// half (feel, assists, input, camera) has its single home here — the client
// modules re-export their old names from it. The shared flight step
// (flight.ts, boost.ts) takes a tuning as a trailing `tuning = DEFAULT_TUNING`
// parameter, so the server and its bots are structurally on the defaults;
// only the Flight Lab's own client and its own solo room ever hold another.
//
// `TUNING_SPEC` describes every field once — its group, plain-English label
// and hint, range and step — and drives both the lab's sliders and the
// clamping of anything imported (a pasted export, a share link, a lab room's
// wire message). Exports are versioned and carry only what differs from the
// default, so a pasted blob reads as "what this pilot changed".
//
// Units: angles are stored in rad (rates in rad/s) exactly as the code reads
// them; `scale` converts for display only. Toggles are 0 / 1.

import {
  BANK_ANGLE,
  BANK_FREQ,
  BANK_PULL,
  BOOST_DRAIN_RATE,
  BOOST_MAX_SPEED,
  BOOST_MIN_START,
  BOOST_PITCH_MULT,
  BOOST_RECHARGE_DELAY_MS,
  BOOST_RECHARGE_RATE,
  BOOST_RESPONSE,
  BOOST_START_COST,
  BOOST_TURN_MULT,
  CAMERA_RESPONSE,
  CHASE_BASE,
  CHASE_RISE,
  CHASE_STRETCH,
  CLIMB_FREE_ANGLE,
  CORNER_BRAKE_DECEL,
  DIVE_FADE_BAND,
  ENERGY_GAIN,
  KNIFE_SPEED,
  MAX_SPEED,
  MIN_SPEED,
  PITCH_LIMIT,
  PITCH_RATE,
  PLAYER_ROLL_RATE,
  ROLL_LEVEL_RATE,
  ROLL_RATE,
  SPEED_RESPONSE,
  THROTTLE_RATE,
  TURN_BLEED,
  TURN_RATE,
  TURN_RATE_SLOW,
} from "./constants";

const DEG = Math.PI / 180;

/** base64 both runtimes have (browsers and Node ≥ 16); common/ compiles
 * without the DOM lib, so they are typed here. */
const b64 = globalThis as unknown as {
  btoa: (s: string) => string;
  atob: (s: string) => string;
};

/** Bumped whenever a field's meaning changes; imports refuse newer ones. */
export const TUNING_VERSION = 1;

export interface FlightTuning {
  // --- Speed ---
  /** Minimum airspeed, m/s (MIN_SPEED). */
  minSpeed: number;
  /** Maximum un-boosted airspeed, m/s (MAX_SPEED). */
  maxSpeed: number;
  /** Commanded-speed change per second at full W/S, m/s² (THROTTLE_RATE). */
  throttleRate: number;
  /** Pull of airspeed toward the commanded speed, 1/s (SPEED_RESPONSE). */
  speedResponse: number;
  /** Throttle axis with nothing on it, −1..1 (flight-input AUTO_THROTTLE). */
  autoThrottle: number;
  /** Speed bleed at full turn/pitch deflection, m/s² (TURN_BLEED). */
  turnBleed: number;
  /** Speed gained in a vertical dive / lost in a vertical climb, m/s²
   * (ENERGY_GAIN). */
  energyGain: number;
  /** Climb angle the engine carries for free, rad (CLIMB_FREE_ANGLE). */
  climbFreeAngle: number;
  /** Band below the top speed over which a dive's gain fades, m/s
   * (DIVE_FADE_BAND). */
  diveFadeBand: number;
  /** F5 corner speed manager (auto-slow near buildings): 1 on, 0 off. */
  autoSlow: number;
  /** Its airbrake, m/s² (CORNER_BRAKE_DECEL). */
  cornerBrakeDecel: number;
  /** How far ahead it looks for walls, m (corner-speed WALL_HORIZON). */
  wallHorizon: number;
  /** Its ceiling's fall / recovery rates, m/s² (CAP_FALL_RATE /
   * CAP_RISE_RATE). */
  capFallRate: number;
  capRiseRate: number;

  // --- Turning ---
  /** Full-deflection yaw rate at maxSpeed, rad/s (TURN_RATE). */
  turnRate: number;
  /** Full-deflection yaw rate at minSpeed, rad/s (TURN_RATE_SLOW). */
  turnRateSlow: number;
  /** Cosmetic lean at full turn, rad (BANK_ANGLE). */
  bankAngle: number;
  /** The lean spring's natural frequency, rad/s (BANK_FREQ). */
  bankFreq: number;
  /** Mouse-aim instructor loop gain, 1/s (the feel's `gain`). */
  instructorGain: number;
  /** Error beyond which a big re-aim is flown at `feelSteer`, rad; 0 = off
   * (crisp everywhere — today's Sharp). */
  feelBand: number;
  /** Slope past the band, 1/s (the feel's `steer`). */
  feelSteer: number;
  /** Classic/touch stick authority, share of the full rates. */
  stickAuthority: number;
  /** F10 mouse-aim bank-and-pull: aim this far off the nose, rad, makes the
   * instructor roll toward it and pull, up to `instructorBankMax` rad of
   * bank (0 = never: today's flat re-aim). */
  instructorBankThreshold: number;
  instructorBankMax: number;

  // --- Roll & Pitch ---
  /** Full-deflection pitch rate, rad/s (PITCH_RATE). */
  pitchRate: number;
  /** Pitch envelope the corner manager plans within and the fast path's
   * bound, rad (PITCH_LIMIT). */
  pitchLimit: number;
  /** Full A/D roll rate, rad/s (ROLL_RATE). */
  rollRate: number;
  /** Self-levelling of a released roll in the flight model, 1/s
   * (ROLL_LEVEL_RATE for bots; F10's player default 0: the bank holds, and
   * the client's roll control does any levelling). */
  rollLevelRate: number;
  /** F10: the A/D roll axis's ramp to full, s (a release ramps out 2.5×
   * faster, so a let-go stops where it is). */
  rollRamp: number;
  /** F10: a double-tap of A/D snaps the roll this far onto that side, rad. */
  snapRollAngle: number;
  /** F10 roll auto-level (Settings: off / gentle / strong): the wait after
   * the last roll input, s, and the gentle / strong levelling rates, 1/s. */
  rollLevelDelay: number;
  rollLevelGentle: number;
  rollLevelStrong: number;
  /** The Flight Lab's override of that setting: 0 = as in Settings, 1 =
   * off, 2 = gentle, 3 = strong. */
  rollLevelMode: number;
  /** F10 bank-and-pull: pitch-rate gain at knife-edge (BANK_PULL); the
   * pitch rate is pitchRate × (1 + bankPull·sin²(real roll)). */
  bankPull: number;
  /** F10 knife-edge side-force: share of the altitude held at 90° bank
   * (1 = all of it), and the airspeed below which it fades, m/s
   * (KNIFE_SPEED). */
  knifeLift: number;
  knifeSpeed: number;

  // --- Assists ---
  /** F9 flight assist (auto-level, coordinated turns, floor, soft walls):
   * 1 on, 0 off. */
  assist: number;
  /** Real roll past which the hole assist and soft walls stand down, rad
   * (ASSIST_MAX_ROLL). */
  assistMaxRoll: number;
  /** Seconds of no input before auto-level may take over (IDLE_S). */
  idleS: number;
  /** …with the aim settled within this of the pipper, rad (IDLE_GAP). */
  idleGap: number;
  /** Ground floor: a dive's predicted bottom keeps this clear, m
   * (FLOOR_MARGIN). */
  floorMargin: number;
  /** H2 hole assist: largest nudge, rad (ASSIST_MAX_RAD); its glide rate,
   * rad/s (ASSIST_RATE); classic stick cap (ASSIST_STICK_MAX); reach, m
   * (ASSIST_RANGE). */
  holeAssistMax: number;
  holeAssistRate: number;
  holeAssistStick: number;
  holeAssistRange: number;
  /** H3 hole save strength: largest position slide, m (SAVE_MAX_OFFSET),
   * largest attitude tweak, rad (SAVE_MAX_ANGLE). */
  saveMaxOffset: number;
  saveMaxAngle: number;

  // --- Mouse & Camera ---
  /** Classic stick: cursor offset multiplier (1 = today). */
  mouseSensitivity: number;
  /** Classic stick: 1 = mouse-up dives. */
  invertY: number;
  /** Classic stick deadzone, share of the half-window (DEADZONE). */
  deadzone: number;
  /** Classic stick expo, 0 linear … 1 cubic (EXPO). */
  expo: number;
  /** Cursor smoothing time constant, s (CURSOR_SMOOTH_S). */
  cursorSmooth: number;
  /** Chase camera response, 1/s — lower lags more (CAMERA_RESPONSE). */
  cameraResponse: number;
  /** Chase distance at minSpeed, m (CHASE_BASE), per m/s above it, s
   * (CHASE_STRETCH), and the arm's rise per meter back (CHASE_RISE). */
  chaseBase: number;
  chaseStretch: number;
  chaseRise: number;
  /** Vertical field of view, degrees (zoom BASE_FOV). */
  baseFov: number;
  /** Extra FOV at maxSpeed, degrees (jet-camera SPEED_FOV_KICK). */
  speedFovKick: number;
  /** Extra FOV at full boost, degrees (main BOOST_FOV_KICK). */
  boostFovKick: number;
  /** Look into the turn, rad per rad/s past the deadband (TURN_LEAD). */
  turnLead: number;
  /** F10 camera roll: 0 = the horizon stays level (default), 1 = the view
   * rolls with the plane (F7's chase camera), between = a blend. */
  cameraRoll: number;

  // --- Boost ---
  /** Top airspeed while boosting, m/s (BOOST_MAX_SPEED). */
  boostMaxSpeed: number;
  /** Pull toward it while boosting, 1/s (BOOST_RESPONSE). */
  boostResponse: number;
  /** Turn / pitch rate multipliers at full boost (BOOST_*_MULT). */
  boostTurnMult: number;
  boostPitchMult: number;
  /** Gauge burned per second / regained per second (BOOST_DRAIN_RATE /
   * BOOST_RECHARGE_RATE). */
  boostDrainRate: number;
  boostRechargeRate: number;
  /** Recharge waits this long after a burn, ms (BOOST_RECHARGE_DELAY_MS). */
  boostRechargeDelay: number;
  /** Gauge a burn needs to start, and what each start costs up front
   * (BOOST_MIN_START / BOOST_START_COST). */
  boostMinStart: number;
  boostStartCost: number;
}

export type TuningKey = keyof FlightTuning;

/** Today's game, exactly. Frozen: the lab works on a copy. */
export const DEFAULT_TUNING: Readonly<FlightTuning> = Object.freeze({
  minSpeed: MIN_SPEED,
  maxSpeed: MAX_SPEED,
  throttleRate: THROTTLE_RATE,
  speedResponse: SPEED_RESPONSE,
  autoThrottle: 0.6,
  turnBleed: TURN_BLEED,
  energyGain: ENERGY_GAIN,
  climbFreeAngle: CLIMB_FREE_ANGLE,
  diveFadeBand: DIVE_FADE_BAND,
  autoSlow: 1,
  cornerBrakeDecel: CORNER_BRAKE_DECEL,
  wallHorizon: 220,
  capFallRate: 250,
  capRiseRate: 12,

  turnRate: TURN_RATE,
  turnRateSlow: TURN_RATE_SLOW,
  bankAngle: BANK_ANGLE,
  bankFreq: BANK_FREQ,
  instructorGain: 8,
  feelBand: 2 * DEG,
  feelSteer: 3.5,
  stickAuthority: 0.85,
  instructorBankThreshold: 35 * DEG,
  instructorBankMax: 80 * DEG,

  pitchRate: PITCH_RATE,
  pitchLimit: PITCH_LIMIT,
  rollRate: PLAYER_ROLL_RATE,
  rollLevelRate: 0,
  rollRamp: 0.08,
  snapRollAngle: 90 * DEG,
  rollLevelDelay: 0.8,
  rollLevelGentle: 1.2,
  rollLevelStrong: 3,
  rollLevelMode: 0,
  bankPull: BANK_PULL,
  knifeLift: 1,
  knifeSpeed: KNIFE_SPEED,

  assist: 1,
  assistMaxRoll: Math.PI / 6,
  idleS: 0.3,
  idleGap: 3 * DEG,
  floorMargin: 10,
  holeAssistMax: 4 * DEG,
  holeAssistRate: 6 * DEG,
  holeAssistStick: 0.15,
  holeAssistRange: 80,
  saveMaxOffset: 1.5,
  saveMaxAngle: 3 * DEG,

  mouseSensitivity: 1,
  invertY: 0,
  deadzone: 0.06,
  expo: 0.5,
  cursorSmooth: 0.04,
  cameraResponse: CAMERA_RESPONSE,
  chaseBase: CHASE_BASE,
  chaseStretch: CHASE_STRETCH,
  chaseRise: CHASE_RISE,
  baseFov: 70,
  speedFovKick: 4,
  boostFovKick: 9,
  turnLead: 0.05,
  cameraRoll: 0,

  boostMaxSpeed: BOOST_MAX_SPEED,
  boostResponse: BOOST_RESPONSE,
  boostTurnMult: BOOST_TURN_MULT,
  boostPitchMult: BOOST_PITCH_MULT,
  boostDrainRate: BOOST_DRAIN_RATE,
  boostRechargeRate: BOOST_RECHARGE_RATE,
  boostRechargeDelay: BOOST_RECHARGE_DELAY_MS,
  boostMinStart: BOOST_MIN_START,
  boostStartCost: BOOST_START_COST,
});

// --- The spec: one row per field -----------------------------------------------

export const TUNING_GROUPS = [
  "Speed",
  "Turning",
  "Roll & Pitch",
  "Assists",
  "Mouse & Camera",
  "Boost",
] as const;
export type TuningGroup = (typeof TUNING_GROUPS)[number];

export interface TuningSpec {
  key: TuningKey;
  group: TuningGroup;
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
  /** A 0/1 switch rather than a slider. */
  toggle?: true;
}

const deg = (
  key: TuningKey,
  group: TuningGroup,
  label: string,
  hint: string,
  min: number,
  max: number,
  step: number,
  unit = "°",
): TuningSpec => ({
  key,
  group,
  label,
  hint,
  min: min * DEG,
  max: max * DEG,
  step: step * DEG,
  unit,
  scale: 1 / DEG,
});

const num = (
  key: TuningKey,
  group: TuningGroup,
  label: string,
  hint: string,
  min: number,
  max: number,
  step: number,
  unit = "",
): TuningSpec => ({ key, group, label, hint, min, max, step, unit });

const toggle = (
  key: TuningKey,
  group: TuningGroup,
  label: string,
  hint: string,
): TuningSpec => ({
  key,
  group,
  label,
  hint,
  min: 0,
  max: 1,
  step: 1,
  unit: "",
  toggle: true,
});

// biome-ignore format: one row per field reads as the table it is
export const TUNING_SPEC: readonly TuningSpec[] = [
  // Speed
  num("minSpeed", "Speed", "Slowest speed", "The plane never flies slower than this — it mushes, never stalls.", 15, 80, 1, "m/s"),
  num("maxSpeed", "Speed", "Top speed", "Full-throttle speed without boost.", 40, 180, 1, "m/s"),
  num("throttleRate", "Speed", "Throttle response", "How fast W/S (and the wheel) change the speed you ask for.", 5, 100, 1, "m/s²"),
  num("speedResponse", "Speed", "Engine response", "How quickly the real speed catches up with the throttle.", 0.1, 3, 0.05, "/s"),
  num("autoThrottle", "Speed", "Hands-off throttle", "Where the throttle drifts with nothing pressed (1 = back to full fast).", 0, 1, 0.05),
  num("turnBleed", "Speed", "Turn speed loss", "Speed lost while turning or pulling hard.", 0, 30, 0.5, "m/s²"),
  num("energyGain", "Speed", "Dive / climb energy", "Speed gained diving straight down (and lost climbing straight up).", 0, 20, 0.5, "m/s²"),
  deg("climbFreeAngle", "Speed", "Free climb angle", "Climbs shallower than this cost no speed.", 0, 70, 1),
  num("diveFadeBand", "Speed", "Dive ease-in", "How gently a dive eases onto top speed instead of hitting a wall.", 1, 40, 1, "m/s"),
  toggle("autoSlow", "Speed", "Auto-slow for corners", "Brakes for you so a street corner or wall ahead is makeable."),
  num("cornerBrakeDecel", "Speed", "Auto-slow brake", "How hard the corner auto-slow brakes.", 5, 60, 1, "m/s²"),
  num("wallHorizon", "Speed", "Auto-slow look-ahead", "How far ahead the auto-slow looks for walls.", 60, 400, 10, "m"),
  num("capFallRate", "Speed", "Auto-slow attack", "How fast the auto-slow clamps down once it sees a corner.", 20, 500, 10, "m/s²"),
  num("capRiseRate", "Speed", "Auto-slow release", "How fast speed is given back once the corner is behind you.", 2, 60, 1, "m/s²"),
  // Turning
  deg("turnRate", "Turning", "Turn rate at top speed", "Fastest heading change at top speed.", 15, 180, 1, "°/s"),
  deg("turnRateSlow", "Turning", "Turn rate when slow", "Fastest heading change at the slowest speed (tighter corners).", 15, 200, 1, "°/s"),
  deg("bankAngle", "Turning", "Turn lean", "How far the plane leans into a full turn (looks only).", 0, 80, 1),
  num("bankFreq", "Turning", "Lean snappiness", "How quickly the lean follows the stick.", 1, 20, 0.5, "/s"),
  num("instructorGain", "Turning", "Aim tightness", "Mouse aim: how hard the nose chases the cursor near the aim point.", 2, 20, 0.5, "/s"),
  deg("feelBand", "Turning", "Gentle re-aim beyond", "Past this angle big re-aims fly softer (0 = crisp everywhere).", 0, 15, 0.5),
  num("feelSteer", "Turning", "Gentle re-aim strength", "How hard a big re-aim turns past that angle.", 0.5, 10, 0.1, "/s"),
  num("stickAuthority", "Turning", "Stick strength", "Classic stick and touch: share of the full turn rate a full stick gives.", 0.3, 1.5, 0.05, "×"),
  deg("instructorBankThreshold", "Turning", "Mouse bank-and-pull beyond", "Mouse aim: a target this far off the nose is reached by rolling toward it and pulling.", 15, 90, 1),
  deg("instructorBankMax", "Turning", "Mouse bank-and-pull bank", "Mouse aim: the most it banks for that turn (0 = turn flat).", 0, 90, 1),
  // Roll & Pitch
  deg("pitchRate", "Roll & Pitch", "Pitch rate", "How fast the nose pulls up or pushes down.", 15, 200, 1, "°/s"),
  deg("pitchLimit", "Roll & Pitch", "Pitch envelope", "Steepest climb the auto-slow plans for, and where loops take over.", 30, 89, 1),
  deg("rollRate", "Roll & Pitch", "Roll rate (A/D)", "How fast A/D roll the plane.", 30, 460, 5, "°/s"),
  num("rollLevelRate", "Roll & Pitch", "Roll self-level (physics)", "Built-in wing levelling after you let go of A/D (0 = the bank holds).", 0, 12, 0.25, "/s"),
  num("rollRamp", "Roll & Pitch", "Roll ramp", "How long A/D take to reach full roll rate (shorter = snappier).", 0, 0.4, 0.01, "s"),
  deg("snapRollAngle", "Roll & Pitch", "Snap-roll angle", "How far a double-tap of A/D snaps the plane onto that side.", 30, 180, 5),
  num("rollLevelMode", "Roll & Pitch", "Roll auto-level mode", "0 = as in Settings, 1 = off, 2 = gentle, 3 = strong.", 0, 3, 1),
  num("rollLevelDelay", "Roll & Pitch", "Roll auto-level delay", "Roll auto-level (Settings): seconds after you let go of A/D before it starts.", 0, 5, 0.1, "s"),
  num("rollLevelGentle", "Roll & Pitch", "Roll auto-level gentle", "How fast GENTLE roll auto-level brings the wings back.", 0.1, 6, 0.1, "/s"),
  num("rollLevelStrong", "Roll & Pitch", "Roll auto-level strong", "How fast STRONG roll auto-level brings the wings back.", 0.5, 12, 0.25, "/s"),
  num("bankPull", "Roll & Pitch", "Bank-and-pull turn", "Extra pull rate on a wing: banked 90° and pulling turns this much harder.", 0, 3, 0.05, "×"),
  num("knifeLift", "Roll & Pitch", "Knife-edge lift", "How much altitude the plane holds flying on its side (1 = all of it).", 0, 1, 0.05),
  num("knifeSpeed", "Roll & Pitch", "Knife-edge min speed", "Below this speed a plane on its side starts to sink.", 20, 120, 1, "m/s"),
  // Assists
  toggle("assist", "Assists", "Flight assist", "Auto-level, coordinated turns, ground floor and soft walls."),
  deg("assistMaxRoll", "Assists", "Assist roll cut-off", "Past this much roll the hole assist and soft walls step aside.", 0, 90, 1),
  num("idleS", "Assists", "Auto-level wait", "Seconds of no input before the wings level themselves.", 0.05, 3, 0.05, "s"),
  deg("idleGap", "Assists", "Auto-level aim slack", "Auto-level only starts with the aim this close to the pipper.", 0.5, 20, 0.5),
  num("floorMargin", "Assists", "Ground floor", "A dive is pulled out to clear the ground by this much.", 0, 60, 1, "m"),
  deg("holeAssistMax", "Assists", "Hole magnet", "Largest nudge toward the middle of a hole you are lined up on.", 0, 15, 0.5),
  deg("holeAssistRate", "Assists", "Hole magnet speed", "How fast that nudge builds up.", 0, 30, 0.5, "°/s"),
  num("holeAssistStick", "Assists", "Hole magnet (stick)", "Classic stick: the nudge's largest share of the stick.", 0, 0.6, 0.01),
  num("holeAssistRange", "Assists", "Hole magnet reach", "How far from a hole the magnet starts.", 20, 200, 5, "m"),
  num("saveMaxOffset", "Assists", "Hole save slide", "Last-moment sideways slide that threads a hole you would clip.", 0, 6, 0.1, "m"),
  deg("saveMaxAngle", "Assists", "Hole save twist", "Last-moment heading tweak for the same save.", 0, 12, 0.5),
  // Mouse & Camera
  num("mouseSensitivity", "Mouse & Camera", "Mouse sensitivity", "Classic stick (M): how far the cursor travels for full stick.", 0.25, 4, 0.05, "×"),
  toggle("invertY", "Mouse & Camera", "Invert Y", "Classic stick (M): mouse up dives."),
  num("deadzone", "Mouse & Camera", "Deadzone", "Classic stick: the still zone around screen centre.", 0, 0.3, 0.01),
  num("expo", "Mouse & Camera", "Response curve", "Classic stick: 0 = linear, 1 = soft centre / sharp edges.", 0, 1, 0.05),
  num("cursorSmooth", "Mouse & Camera", "Input smoothing", "Takes the twitch out of the hand (adds a little lag).", 0, 0.3, 0.01, "s"),
  num("cameraResponse", "Mouse & Camera", "Camera tightness", "How tightly the chase camera follows (lower = more lag).", 0.5, 15, 0.25, "/s"),
  num("chaseBase", "Mouse & Camera", "Camera distance", "How far behind the plane the camera sits.", 8, 60, 1, "m"),
  num("chaseStretch", "Mouse & Camera", "Camera speed stretch", "Extra distance per m/s of speed.", 0, 0.5, 0.01, "s"),
  num("chaseRise", "Mouse & Camera", "Camera height", "How high above the plane's tail the camera rides.", 0, 0.8, 0.01, "×"),
  num("baseFov", "Mouse & Camera", "Field of view", "Vertical field of view.", 45, 100, 1, "°"),
  num("speedFovKick", "Mouse & Camera", "Speed FOV kick", "Extra field of view at top speed.", 0, 20, 0.5, "°"),
  num("boostFovKick", "Mouse & Camera", "Boost FOV kick", "Extra field of view at full boost.", 0, 25, 0.5, "°"),
  num("turnLead", "Mouse & Camera", "Look into turns", "How much the camera looks into a hard turn.", 0, 0.3, 0.01),
  num("cameraRoll", "Mouse & Camera", "Camera roll", "0 = the horizon stays level when you roll; 1 = the view rolls with the plane.", 0, 1, 0.05),
  // Boost
  num("boostMaxSpeed", "Boost", "Boost top speed", "Top speed while holding SPACE.", 50, 260, 1, "m/s"),
  num("boostResponse", "Boost", "Boost kick", "How hard the boost shoves you toward its top speed.", 0.2, 5, 0.1, "/s"),
  num("boostTurnMult", "Boost", "Boost turn", "Turn rate multiplier while boosting.", 0.5, 3, 0.05, "×"),
  num("boostPitchMult", "Boost", "Boost pitch", "Pitch rate multiplier while boosting.", 0.5, 3, 0.05, "×"),
  num("boostDrainRate", "Boost", "Boost burn rate", "Gauge used per second of boost (0.33 = a 3 s burn).", 0.05, 2, 0.01, "/s"),
  num("boostRechargeRate", "Boost", "Boost recharge", "Gauge regained per second after a burn.", 0.02, 2, 0.01, "/s"),
  num("boostRechargeDelay", "Boost", "Boost recharge wait", "How long the gauge waits after a burn before it refills.", 0, 5000, 100, "ms"),
  num("boostMinStart", "Boost", "Boost minimum", "How full the gauge must be to start a burn.", 0, 0.9, 0.05),
  num("boostStartCost", "Boost", "Boost start cost", "Gauge every start costs up front (stops tap-spamming).", 0, 0.5, 0.01),
];

const SPEC_BY_KEY = new Map(TUNING_SPEC.map((s) => [s.key, s]));

/** The spec row for `key`. Every FlightTuning field has one. */
export function tuningSpec(key: TuningKey): TuningSpec {
  return SPEC_BY_KEY.get(key) as TuningSpec;
}

/** Gaps the cross-field rules keep, m/s: the flight step divides by
 * maxSpeed − minSpeed and by boostMaxSpeed − maxSpeed. */
const SPEED_GAP = 5;

// --- Presets -------------------------------------------------------------------

export interface TuningPreset {
  id: string;
  name: string;
  hint: string;
  /** What differs from DEFAULT_TUNING. */
  values: Partial<FlightTuning>;
}

export const TUNING_PRESETS: readonly TuningPreset[] = [
  {
    id: "default",
    name: "Current default",
    hint: "The game as it ships today.",
    values: {},
  },
  {
    id: "relaxed",
    name: "Relaxed",
    hint: "The Relaxed feel: gentle aim, soft stick.",
    values: {
      instructorGain: 6,
      feelBand: 2 * DEG,
      feelSteer: 2.5,
      stickAuthority: 0.7,
    },
  },
  {
    id: "normal",
    name: "Normal",
    hint: "The Normal feel (today's default).",
    values: {
      instructorGain: 8,
      feelBand: 2 * DEG,
      feelSteer: 3.5,
      stickAuthority: 0.85,
    },
  },
  {
    id: "sharp",
    name: "Sharp",
    hint: "The Sharp feel: crisp aim everywhere, full stick.",
    values: { instructorGain: 10, feelBand: 0, stickAuthority: 1 },
  },
  {
    id: "arcade-jet",
    name: "Arcade jet",
    hint: "Fast, twitchy and forgiving: big speed, snappy rolls, little bleed.",
    values: {
      minSpeed: 55,
      maxSpeed: 130,
      throttleRate: 60,
      speedResponse: 1.2,
      autoThrottle: 1,
      turnBleed: 3,
      energyGain: 5,
      turnRate: 1.25,
      turnRateSlow: 1.7,
      bankFreq: 10,
      instructorGain: 11,
      feelBand: 0,
      stickAuthority: 1,
      pitchRate: 1.5,
      rollRate: 7,
      rollRamp: 0.05,
      bankPull: 1.4,
      cameraResponse: 5,
      chaseBase: 24,
      chaseStretch: 0.14,
      baseFov: 74,
      speedFovKick: 8,
      boostFovKick: 12,
      boostMaxSpeed: 185,
      boostResponse: 2.5,
      boostTurnMult: 1.3,
      boostPitchMult: 1.3,
      boostDrainRate: 0.25,
      boostRechargeRate: 0.25,
    },
  },
  {
    id: "realistic-biplane",
    name: "Realistic biplane",
    hint: "Slow and floaty: energy matters, turns bleed speed, wings stay where you put them.",
    values: {
      minSpeed: 28,
      maxSpeed: 62,
      throttleRate: 14,
      speedResponse: 0.3,
      autoThrottle: 0.3,
      turnBleed: 12,
      energyGain: 11,
      climbFreeAngle: 0.15,
      diveFadeBand: 6,
      turnRate: 0.8,
      turnRateSlow: 1.1,
      bankAngle: 1.2,
      bankFreq: 4,
      instructorGain: 6,
      feelBand: 3 * DEG,
      feelSteer: 2.2,
      stickAuthority: 0.8,
      pitchRate: 0.85,
      rollRate: 2.6,
      rollRamp: 0.15,
      bankPull: 0.8,
      knifeLift: 0.45,
      knifeSpeed: 45,
      cameraResponse: 2.5,
      chaseBase: 20,
      chaseStretch: 0.08,
      baseFov: 66,
      speedFovKick: 2,
      boostFovKick: 4,
      boostMaxSpeed: 78,
      boostResponse: 0.8,
      boostTurnMult: 1.2,
      boostPitchMult: 1.15,
    },
  },
];

/**
 * The flight model the server's bots fly (F10): the defaults with the
 * pre-F10 roll — ROLL_RATE, the flight model's own self-levelling
 * (ROLL_LEVEL_RATE: their barrel rolls roll out on it), no bank-and-pull
 * gain and no knife-edge sink — so every bot flies bit-for-bit as before.
 */
export const BOT_TUNING: Readonly<FlightTuning> = Object.freeze({
  ...DEFAULT_TUNING,
  rollRate: ROLL_RATE,
  rollLevelRate: ROLL_LEVEL_RATE,
  bankPull: 0,
  knifeLift: 1,
  knifeSpeed: 0,
});

/** DEFAULT_TUNING with a preset's values on top (a fresh, mutable copy). */
export function presetTuning(preset: TuningPreset): FlightTuning {
  return sanitizeTuning(preset.values);
}

// --- Clamping, export and import ----------------------------------------------

/** `v` into the field's range; toggles snap to 0/1. Non-finite → default. */
function clampField(key: TuningKey, v: unknown): number {
  const d = DEFAULT_TUNING[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return d;
  const s = tuningSpec(key);
  if (s.toggle) return v >= 0.5 ? 1 : 0;
  return Math.min(s.max, Math.max(s.min, v));
}

/**
 * Any value (parsed JSON, a partial preset, a wire message) → a valid
 * FlightTuning: DEFAULT_TUNING with every known, finite field clamped into
 * its range on top. Unknown keys and non-numbers are dropped. Then the
 * cross-field rules: maxSpeed ≥ minSpeed + 5 and boostMaxSpeed ≥ maxSpeed
 * + 5 (the step divides by both gaps).
 */
export function sanitizeTuning(raw: unknown): FlightTuning {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const t = { ...DEFAULT_TUNING } as FlightTuning;
  for (const s of TUNING_SPEC) {
    if (Object.hasOwn(o, s.key)) t[s.key] = clampField(s.key, o[s.key]);
  }
  t.maxSpeed = Math.max(t.maxSpeed, t.minSpeed + SPEED_GAP);
  t.boostMaxSpeed = Math.max(t.boostMaxSpeed, t.maxSpeed + SPEED_GAP);
  return t;
}

/** The fields of `t` that differ from DEFAULT_TUNING. */
export function tuningDiff(t: Readonly<FlightTuning>): Partial<FlightTuning> {
  const out: Partial<FlightTuning> = {};
  for (const s of TUNING_SPEC) {
    if (t[s.key] !== DEFAULT_TUNING[s.key]) out[s.key] = t[s.key];
  }
  return out;
}

/** What "Copy settings" puts on the clipboard: compact JSON, version + diff. */
export function exportTuning(t: Readonly<FlightTuning>): string {
  return JSON.stringify({ v: TUNING_VERSION, t: tuningDiff(t) });
}

export type TuningImport =
  | { ok: true; tuning: FlightTuning }
  | { ok: false; error: string };

/** The decoded object of an export → a valid FlightTuning, or why not. */
export function importTuningObject(raw: unknown): TuningImport {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "not a Flight Lab export" };
  }
  const { v, t } = raw as { v?: unknown; t?: unknown };
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: "missing version" };
  }
  if (v > TUNING_VERSION) {
    return { ok: false, error: `made by a newer Flight Lab (v${v})` };
  }
  if (!t || typeof t !== "object" || Array.isArray(t)) {
    return { ok: false, error: "no settings in it" };
  }
  return { ok: true, tuning: sanitizeTuning(t) };
}

/** A pasted export (JSON text) → a valid FlightTuning, or why not. */
export function importTuning(text: string): TuningImport {
  try {
    return importTuningObject(JSON.parse(text));
  } catch {
    return { ok: false, error: "not valid JSON" };
  }
}

/** The `?lab=` value for `t`: the export, base64url. */
export function encodeShare(t: Readonly<FlightTuning>): string {
  return b64
    .btoa(exportTuning(t))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** A `?lab=` value → a valid FlightTuning, or why not. */
export function decodeShare(code: string): TuningImport {
  try {
    const s = code.replace(/-/g, "+").replace(/_/g, "/");
    return importTuning(b64.atob(s + "=".repeat((4 - (s.length % 4)) % 4)));
  } catch {
    return { ok: false, error: "broken share link" };
  }
}

// --- Derived views -------------------------------------------------------------

/** The instructor's loop shape and stick authority a tuning asks for — the
 * same shape as effortless.ts FEEL_TUNING's entries. `feelBand` 0 means no
 * band at all (the exact linear path of today's Sharp), never a zero band. */
export function feelFromTuning(t: Readonly<FlightTuning>): {
  gain: number;
  band?: number;
  steer?: number;
  stick: number;
} {
  return t.feelBand > 0
    ? {
        gain: t.instructorGain,
        band: t.feelBand,
        steer: t.feelSteer,
        stick: t.stickAuthority,
      }
    : { gain: t.instructorGain, stick: t.stickAuthority };
}

/** The fastest airspeed a lab room's validation allows for `t`, m/s — the
 * lab's stand-in for the boost mirror (boostMaxSpeed ≥ maxSpeed always). */
export function labSpeedCap(t: Readonly<FlightTuning>): number {
  return Math.max(t.maxSpeed, t.boostMaxSpeed);
}

// T2: solo flight over the torus city. T3: the same city, shared. T4: the
// dogfight — hold the mouse to fire heat-limited bursts, bullets simulate
// locally and hits are claimed to the server (favor the shooter), while HP,
// kills, deaths, and respawns only ever arrive FROM the server (authority
// split). Death freezes the plane for a kill-cam beat until the server's
// respawn message reseeds the flight state far from every enemy.

import {
  boostLevel,
  boostSpeedCap,
  createBoost,
  startBoost,
  stopBoost,
} from "@angels-bandits/common/boost";
import { type Building, cityHoles } from "@angels-bandits/common/city";
import {
  generateMovers,
  withNewsHeli,
} from "@angels-bandits/common/city/movers";
import { natureFor } from "@angels-bandits/common/city/nature";
import { setNewsTarget } from "@angels-bandits/common/city/newsheli";
import { bridgeSpans } from "@angels-bandits/common/city/river";
import { buildNatureIndex } from "@angels-bandits/common/collision";
import {
  AWAY_MIN_MS,
  AWAY_PING_INTERVAL_MS,
  BLOCK_PITCH,
  BOOST_MAX_SPEED,
  BOOT_PING_INTERVAL_MS,
  BULLET_DAMAGE,
  BULLET_SPEED,
  CLOUD_BASE,
  FOG_DISTANCE,
  MAX_HP,
  MAX_SPEED,
  MIN_SPEED,
} from "@angels-bandits/common/constants";
import {
  type FlightState,
  createFlightState,
  handlingRates,
  stepFlight,
} from "@angels-bandits/common/flight";
import { hitRangeBudgetFor } from "@angels-bandits/common/net";
import type {
  DeathMsg,
  ScoreEntry,
  SpawnState,
  WelcomeMsg,
} from "@angels-bandits/common/protocol";
import { airlinerOffsetInto } from "@angels-bandits/common/skytraffic";
import { strikesInWindow } from "@angels-bandits/common/storm";
import {
  WEATHER_PHASES,
  type WeatherPhase,
  phaseWindow,
} from "@angels-bandits/common/weather";
import {
  type Vec3,
  wrapDelta,
  wrapDistance,
} from "@angels-bandits/common/world";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { CityAmbience } from "./audio/ambience";
import { Busker } from "./audio/busker";
import { RadioQueue, RadioVoice } from "./audio/radio";
import { GameAudio } from "./audio/sound";
import { NEAR_MISS_RADIUS, closestApproach, spatialize } from "./audio/spatial";
import { ThunderSchedule } from "./audio/thunder";
import { TrainAudio } from "./audio/train-audio";
import { createAutoFire, stepAutoFire } from "./game/auto-fire";
import { BoostKey } from "./game/boost-key";
import { Bullets } from "./game/bullets";
import {
  AmbientChatter,
  type Callout,
  LOW_HP_CALLOUT,
  checkInCallout,
  hitCallout,
  maydayCallout,
  nearMissCallout,
  offStationCallout,
  ownKillCallout,
  splashCallout,
  threatCallout,
  threatOnSix,
} from "./game/callouts";
import { ChaseCamera } from "./game/camera";
import { detectCrash, touchesSolid } from "./game/collision";
import {
  type CornerWorld,
  cornerCapInput,
  cornerSpeed,
  holeCorridors,
  stepCornerCap,
} from "./game/corner-speed";
import { type AimMode, FlightInputSource } from "./game/flight-input";
import { createFreeLook, shapeInput, stepFreeLook } from "./game/freelook";
import { Guns } from "./game/guns";
import {
  feedLine,
  killHeadline,
  pilotLabel,
  replaySubject,
  stormWarning,
  topPilot,
} from "./game/headlines";
import { bulletImpact, impactKind } from "./game/hitdetect";
import {
  ASSIST_AIM_RANGE,
  type AssistWorld,
  assistStick,
  createHoleAssist,
  holeAssistTarget,
  stepHoleAssist,
} from "./game/hole-assist";
import {
  type AimError,
  CONVERGED_RAD,
  aimError,
  aimView,
  angleBetween,
  createInstructor,
  instructorInput,
} from "./game/instructor";
import { speedFov } from "./game/jet-camera";
import { magnetizeVelocity } from "./game/magnetism";
import {
  BASE_FOV,
  createZoom,
  stepZoom,
  zoomFov,
  zoomHeld,
  zoomSteer,
} from "./game/zoom";
import { GameSocket } from "./net/socket";
import { Airliners } from "./render/airliners";
import { Birds } from "./render/birds";
import { CityRenderer } from "./render/city";
import { PICKUP_TAXIS } from "./render/citylife";
import { CityLife } from "./render/citylife-render";
import { ConstructionSparks } from "./render/construction";
import { DroneShowRenderer } from "./render/drones";
import { FacadeDetailRenderer } from "./render/facade-detail";
import { FacadeGarnishRenderer } from "./render/facade-garnish";
import { FacadeLifeRenderer } from "./render/facade-life";
import { Fireworks } from "./render/fireworks";
import { installHeightFog } from "./render/fog";
import { Fountains } from "./render/fountains";
import { Explosions, Sparks } from "./render/fx";
import { GpuTimer } from "./render/gputimer";
import { createGradePass } from "./render/grade";
import { Headlights } from "./render/headlights";
import { HoleDecorRenderer } from "./render/hole-decor";
import { Jumbotrons } from "./render/jumbotrons";
import { lookPasses } from "./render/lookup";
import { MoverLights, Movers } from "./render/movers";
import { NatureRenderer } from "./render/nature";
import { Pedestrians } from "./render/pedestrians";
import { FrameMeter, type FrameStats, percentile } from "./render/perfmeter";
import {
  type ControlDeflection,
  NEUTRAL_CONTROLS,
  animatePlane,
  buildPlaneMesh,
  inputControls,
  liveryFor,
  spinPropeller,
} from "./render/plane";
import { PlaneLights } from "./render/planelights";
import { AbBloomPass, DiscardDepthPass, FinalPass } from "./render/post";
import { prewarmScene } from "./render/prewarm";
import {
  type AutoQualityState,
  DEFAULT_QUALITY,
  QUALITY_KEY,
  QUALITY_PROFILES,
  QUALITY_STORAGE_KEY,
  type QualitySetting,
  type QualityTier,
  type ThermalState,
  autoStartTier,
  bloomOn,
  createAutoQuality,
  createThermal,
  interruptAutoQuality,
  interruptThermal,
  nextQualitySetting,
  parseQualitySetting,
  qualityLimits,
  stepAutoQuality,
  stepThermal,
  tierBudgetMs,
  tierMissMs,
} from "./render/quality";
import { Rain } from "./render/rain";
import { CityReactor } from "./render/reactions";
import { RemotePlanes } from "./render/remotes";
import {
  MSAA_SAMPLES,
  type PostMode,
  readRenderOptions,
} from "./render/renderopts";
import {
  RELAX_AFTER_MS,
  type ResolutionLimits,
  type ResolutionState,
  WINDOW_FRAMES,
  createResolution,
  defaultLimits,
  missShare,
  stepResolution,
} from "./render/resolution";
import { RiverRenderer } from "./render/river";
import { RoofClutterRenderer } from "./render/roofclutter";
import { RooftopLifeRenderer } from "./render/rooftop-life";
import { Searchlights } from "./render/searchlights";
import { Signage } from "./render/signage";
import { Signals } from "./render/signals";
import { EXPOSURE, GroundPlane, SkyDome, setupSky } from "./render/sky";
import {
  SKY_MOMENTS,
  SkyCycle,
  parseSkyParam,
  skyPhase,
} from "./render/skycycle";
import { SmokeTrails, smokeActive } from "./render/smoke";
import { Steam } from "./render/steam";
import {
  CloudDeck,
  REVEAL_COLOR,
  REVEAL_INTENSITY,
  StormRenderer,
  StormReveals,
  StrikeFeed,
  thunderGain,
  turbulenceOffset,
} from "./render/storm";
import { MAX_CART_VENTS_PER_BLOCK } from "./render/street-detail";
import {
  StreetFurniture,
  buildStreetDetailContext,
} from "./render/street-furniture";
import { microGate } from "./render/streetlife";
import { Streetlights } from "./render/streetlights";
import { Tracers } from "./render/tracers";
import { Traffic } from "./render/traffic";
import { PlaneTrails } from "./render/trails";
import { TrainRenderer } from "./render/train";
import { WeatherClock, setWeatherUniform } from "./render/weather";
import { nearestImage } from "./render/wrapPlacement";
import { BotBar } from "./ui/botbar";
import { Coach, renderPrimer } from "./ui/coach";
import { CommsTicker } from "./ui/comms";
import { DamageIndicator } from "./ui/damage-indicator";
import { initFullscreenUi } from "./ui/fullscreen";
import { Haptics } from "./ui/haptics";
import { HPBAR_ALTITUDE, HpBarSprite, HpBarTracker } from "./ui/hpbar";
import { Hud, deathLabel } from "./ui/hud";
import {
  closeJoin,
  requestName,
  showJoinError,
  showJoinProgress,
  showSignalLost,
  takeResumeToken,
} from "./ui/join";
import { KillFeed } from "./ui/killfeed";
import { LeadIndicator, SolutionTone } from "./ui/lead";
import { EdgeMarkers } from "./ui/markers";
import { Minimap } from "./ui/minimap";
import {
  coarsePointer,
  initMobileShell,
  isTouch,
  whenTouch,
} from "./ui/mobile";
import { PerfHud, bindPerfHudKey, perfHudKeyEnabled } from "./ui/perfhud";
import { initPhoneFullscreen } from "./ui/phone-fullscreen";
import { Scoreboard } from "./ui/scoreboard";
import {
  type Settings,
  type SettingsStore,
  autopilotInput,
  loadSettings,
  scaleLimits,
  volumeGain,
} from "./ui/settings";
import { SettingsPanel } from "./ui/settings-panel";
import { readStored, writeStored } from "./ui/storage";
import { TouchControls } from "./ui/touch-controls";

// Fullscreen chrome first — the join overlay carries its own toggle button,
// so it must be live before the name prompt (hidden where unsupported).
initFullscreenUi();
// M2: touch chrome, gesture lock and keyboard-aware join — before the name
// prompt, which is the first thing a phone types into. No-op on desktop.
initMobileShell();
// M5: phone fullscreen — after the shell (it reads body.touch / --vv-h),
// before the name prompt (the JOIN tap is its gesture; the iPhone sheet
// greets the join card). No-op on desktop.
const phoneFullscreen = initPhoneFullscreen();
// U3: the join card's controls primer — after the shell (body.touch picks
// the variant), switching to touch if the first real touch comes later.
renderPrimer(isTouch());
whenTouch(() => renderPrimer(true));

// --- Join flow: name → server welcome (identity, seed, spawn) ---
const name = await requestName(phoneFullscreen.onJoinGesture);
let socket: GameSocket;
try {
  // W2: a SIGNAL LOST reload hands its session over, so it comes back as
  // the same player (same id and score) when the server still holds it.
  socket = await GameSocket.connect(name, takeResumeToken());
} catch (err) {
  showJoinError(err instanceof Error ? err.message : "Can't reach the server");
  throw err;
}
// Only once connected: a failed join must not grow a pill over its error.
phoneFullscreen.onJoined();
const { welcome } = socket;
// W1: the boot below (synchronous city build, then the shader pre-warm) can
// run for seconds on a slow phone. A drop at ANY point of it must still end
// on SIGNAL LOST — remembered here, shown the moment the boot can show it
// (the full handler is wired once the loop runs, at the bottom).
let droppedDuringBoot = false;
socket.events.onClose = () => {
  droppedDuringBoot = true;
};
// W2: a drop during the boot usually resumes in the background — its fresh
// welcome (roster, scores, spawn) is applied once the handlers exist.
let resumedDuringBoot: WelcomeMsg | null = null;
socket.events.onResumed = (w) => {
  resumedDuringBoot = w;
};
// Keepalive until the first pose: the interval covers the async stretches,
// the explicit pings below bracket the synchronous ones (no timer fires
// inside them). The server holds this player pending — invisible, untargeted,
// protection not yet started — until that first pose.
const bootPing = setInterval(() => socket.sendPing(), BOOT_PING_INTERVAL_MS);
await showJoinProgress("LOADING CITY…");
socket.sendPing();

// --- Scene & renderer ---
const scene = new THREE.Scene();
// Before anything compiles: the haze layer lives in three's fog chunks, and
// (L4) the weather's haze uniform is patched into every fogged ShaderLib
// entry here — any program compiled earlier (a pre-warm) would miss it.
installHeightFog();
const skyRig = setupSky(scene); // L12: the sky cycle drives these lights

// O1: near 1 m, not 0.1 m — depth precision scales with near/far, so this
// is 10x the precision at range (no z-fighting of ground details from
// altitude). Nothing is ever drawn closer: the chase camera sits >= 6 m
// (ZOOM_DISTANCE) behind the plane.
const camera = new THREE.PerspectiveCamera(
  BASE_FOV,
  window.innerWidth / window.innerHeight,
  1.0,
  FOG_DISTANCE + 100,
);

// P1 render knobs. Defaults ARE what ships; the query params exist so the
// headless perf harness can measure two AA modes and a pinned pixel ratio
// out of one build (client/src/render/renderopts.ts).
const renderOpts = readRenderOptions(
  window.location.search,
  window.devicePixelRatio,
);
// O3 graphics quality: the URL wins (QA links, the perf harness), then the
// player's saved pick (G / the HUD entry), then the shipped default, Auto.
// Auto starts at High and only ever steps down (render/quality.ts).
// Storage blocked reads as no pick: the default is fine.
let qualitySetting: QualitySetting =
  renderOpts.quality ??
  parseQualitySetting(readStored(QUALITY_STORAGE_KEY)) ??
  DEFAULT_QUALITY;
// M3: Auto starts at Mobile on a coarse-pointer device (M2's touch rule),
// at High everywhere else. Read once: the device does not change mid-session.
const autoStart = autoStartTier(coarsePointer());
let autoQuality = createAutoQuality(performance.now(), autoStart);
// M3: the thermal step-down below Mobile (render/quality.ts). Only Auto on
// the Mobile tier steps it; a hand-picked tier resets it to level 0.
let thermal = createThermal(performance.now());
let qualityTier: QualityTier =
  qualitySetting === "auto" ? autoQuality.tier : qualitySetting;
// M6 settings (ui/settings.ts): the new values (resolution scale, volumes)
// load here, before anything sizes a pixel ratio or plays a sound. The rest
// keep their own homes (quality above, aim mode, sensitivity, radio voice).
const settingsStore = ((): SettingsStore | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined; // `localStorage` itself throws where storage is blocked
  }
})();
let settings = loadSettings(settingsStore);
/** O3's scaler limits under a tier and thermal level, with the player's
 * resolution scale (M6) on top. The one place the scaler's limits are made. */
const limitsFor = (tier: QualityTier): ResolutionLimits =>
  scaleLimits(
    qualityLimits(window.devicePixelRatio, tier, thermal.level),
    settings.resScale,
  );
// Recomputed on resize: browser zoom and dragging the window to another
// panel both change devicePixelRatio AND fire `resize`, and a stale ceiling
// either strands the scaler below the panel or lets it burn 4x the pixels.
// The quality tier caps the ceiling (High 2, Medium 1.5, Low 1, Mobile 1),
// and a thermal level caps it further (M3).
let resLimits = limitsFor(qualityTier);
let resAuto = renderOpts.pixelRatio === "auto";
let resolution =
  renderOpts.pixelRatio === "auto"
    ? autoResolution(performance.now())
    : pinnedResolution(renderOpts.pixelRatio);

/**
 * A fresh adaptive state at the current tier's ceiling: the panel's ratio,
 * capped by the tier, no latch. Used at boot, on `setPixelRatio("auto")`
 * and on every tier change — a new tier must not inherit the latch the old
 * one earned, or a CPU-bound drop would leave the player blurry AND reduced
 * for the minutes the latch takes to relax.
 */
function autoResolution(now: number): ResolutionState {
  const fresh = createResolution(window.devicePixelRatio, now);
  return { ...fresh, ratio: Math.min(fresh.ratio, resLimits.ceiling) };
}

/** A pinned (non-adaptive) state: clamped to the PANEL, with no latch. The
 * quality tier's cap does not apply — a pinned ratio is a QA instrument. */
function pinnedResolution(ratio: number): ResolutionState {
  const panel = defaultLimits(window.devicePixelRatio);
  return {
    ratio: Math.min(panel.ceiling, Math.max(panel.floor, ratio)),
    changedAt: 0,
    hotRatio: Number.POSITIVE_INFINITY,
    cleanSince: null,
    relaxAfterMs: RELAX_AFTER_MS,
  };
}

// `antialias` is a CONTEXT attribute — it antialiases the default
// framebuffer, and with the composer in the chain the scene never touches
// that; only OutputPass's fullscreen quad does. So it used to buy a
// multisampled backbuffer, and its per-frame resolve, for one textured
// quad while the city itself stayed jagged. Real scene AA now comes from
// the composer target (msaa) or an SMAA pass (smaa); `legacy` reproduces
// the old wiring so the harness can measure the before/after in one build.
const renderer = new THREE.WebGLRenderer({
  antialias: renderOpts.aa === "legacy",
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(resolution.ratio);
// Filmic curve keeps the HDR emissives from clipping; the OutputPass applies
// this + sRGB at the end of the composer chain.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// VO1: the whole-image lift. Applied by OutputPass AFTER bloom, so it brightens
// the frame without moving which pixels cross the 0.72 bloom threshold.
renderer.toneMappingExposure = EXPOSURE;
document.body.appendChild(renderer.domElement);
// Read once, here, while the DEFAULT framebuffer is the bound one — this is
// the receipt for win A. `antialias: true` multisamples the default
// framebuffer, and the scene never renders into it; QA reads this next to
// the composer target's own sample count to see the mismatch as two numbers
// rather than as an argument.
const DEFAULT_FB_SAMPLES = renderer
  .getContext()
  .getParameter(WebGLRenderingContext.SAMPLES) as number;

// --- Post pipeline: render → bloom → tonemap+sRGB (V1 night look) ---
// The bloom threshold sits above everything lit-but-not-emissive (facades peak
// ~0.05 luminance in linear HDR, the sky dome ~0.05) and below the emissives
// (windows ~0.8+, lamp heads ~0.9, tracers ~1.5) — so ONLY emissives glow.
// The blur chain runs from half the CSS resolution (O4: AbBloomPass — at
// ratio 2 that is a quarter of the drawing buffer per axis, same halo).
// Strength and radius are the LOOK (a wider, gentler halo reads as haze
// around a light rather than a hard glow); the threshold is the CONTRACT the
// emissive ladder is built against and does not move.
const BLOOM_STRENGTH = 0.4;
const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 0.72;
// The composer owns its own render target so `msaa` can put samples on the
// buffer the SCENE is actually drawn into. HalfFloat matches what
// EffectComposer would have allocated on its own — the HDR emissive ladder
// depends on it, so it is not negotiable.
const bufferSize = renderer.getDrawingBufferSize(new THREE.Vector2());
const composer = new EffectComposer(
  renderer,
  new THREE.WebGLRenderTarget(bufferSize.x, bufferSize.y, {
    type: THREE.HalfFloatType,
    samples: renderOpts.aa === "msaa" ? MSAA_SAMPLES : 0,
  }),
);
// Passing a target makes the composer take its size from that target (in
// drawing-buffer pixels) — hand it the CSS size once so its own
// pixelRatio bookkeeping starts from the same place setSize() uses.
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
// O4: nothing after the scene pass reads its depth — tell a tile GPU not to
// write it back to memory (a no-op where the driver ignores the hint).
composer.addPass(new DiscardDepthPass());
// O4 (render/post.ts): the bloom chain at CSS density, then bloom add + tone
// map + sRGB + grade in ONE full-res pass. `?post=legacy` rebuilds the old
// chain (three's UnrealBloomPass with its full-res additive blend, the
// OutputPass and a separate grade pass) out of the same build, so the
// harness can measure the difference as a paired --ab.
const legacyPost = renderOpts.post === "legacy";
const bloomPass = legacyPost
  ? new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    )
  : new AbBloomPass(BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
composer.addPass(bloomPass);
/** What the sky cycle tints and M3's tiers switch: the fused pass's grade
 * (a uniform inside FinalPass), or the legacy chain's own grade pass. */
let gradePass: {
  uniforms: Record<string, THREE.IUniform>;
  enabled: boolean;
} | null = null;
if (bloomPass instanceof AbBloomPass) {
  const finalPass = new FinalPass(bloomPass, renderOpts.grade);
  composer.addPass(finalPass);
  if (renderOpts.grade) {
    gradePass = {
      uniforms: finalPass.uniforms,
      get enabled() {
        return finalPass.gradeEnabled;
      },
      set enabled(on: boolean) {
        finalPass.gradeEnabled = on;
      },
    };
  }
} else {
  composer.addPass(new OutputPass());
  // The grade works on the display-referred image, so it follows the
  // OutputPass.
  if (renderOpts.grade) {
    const legacyGrade = createGradePass();
    composer.addPass(legacyGrade);
    gradePass = legacyGrade;
  }
}
// SMAA goes AFTER the output pass, on purpose: its edge detection wants the
// tonemapped, sRGB-encoded image, not linear HDR where a bloomed window
// swamps every luma gradient near it.
if (renderOpts.aa === "smaa") {
  composer.addPass(new SMAAPass(bufferSize.x, bufferSize.y));
}
// The composer renders many passes per frame — reset the info counters
// ourselves so __ab.perf() reports the whole frame, not just the last pass.
renderer.info.autoReset = false;

/**
 * Resize everything that is sized in DEVICE pixels, together. `composer`
 * owns its render targets AND forwards setSize to every pass, so the bloom
 * chain and the SMAA buffers follow from this one call — nothing here may
 * be split up or the passes drift out of step with the framebuffer.
 */
function applyPixelRatio(ratio: number): void {
  renderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
  // The bloom chain is anchored to CSS pixels (render/post.ts).
  if (bloomPass instanceof AbBloomPass) bloomPass.setPixelRatio(ratio);
}
applyPixelRatio(resolution.ratio);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  // A resize changes the pixel count the scaler learned its limit at, so
  // the latch is stale: leaving fullscreen must be allowed to win the
  // resolution back. Only the latch is cleared — the current ratio stays,
  // and the controller re-earns anything above it the usual way.
  resLimits = limitsFor(qualityTier);
  interruptQuality();
  resolution = {
    ...resolution,
    hotRatio: Number.POSITIVE_INFINITY,
    cleanSince: null,
    relaxAfterMs: RELAX_AFTER_MS,
  };
  resFrames.reset();
  cpuFrames.reset();
});

// --- World (city seed comes from the server so every roommate agrees) ---
const city = new CityRenderer(welcome.seed);
scene.add(city.mesh);
// Roof clutter + landmark beacons dress the same shared Building[] (V2).
const roofClutter = new RoofClutterRenderer(city.cityBuildings);
scene.add(roofClutter.group);
// L8 rooftop life (ANGE-972BJX): parties, pools, fans, flags, aviation
// lights — two static draws placed and animated on the GPU from one uniform.
const rooftopLife = new RooftopLifeRenderer(city.cityBuildings);
scene.add(rooftopLife.group);
// Parapet caps + entrance canopies dress the same shared Building[] (ANGE-XY8LH8).
const facadeGarnish = new FacadeGarnishRenderer(city.cityBuildings);
scene.add(facadeGarnish.group);
// L13 facade detail (ANGE-G6JR64): fire escapes, balconies, AC units and
// scaffolding, streamed per camera block (r = 2) and faded on the GPU.
const facadeDetail = new FacadeDetailRenderer(city.cityBuildings, welcome.seed);
scene.add(facadeDetail.group);
const ground = new GroundPlane();
scene.add(ground.mesh);
const skyDome = new SkyDome();
scene.add(skyDome.mesh);
// L10 airliners ride the dome like the stars: camera-following, fog off,
// never in world space. Pure schedule of (seed, synced clock).
const airliners = new Airliners(welcome.seed);
skyDome.mesh.add(airliners.points);
const streetlights = new Streetlights();
scene.add(streetlights.group);
// L12 sky cycle: dusk → deep night → pre-dawn on the synced server clock
// (~40 min loop). Writes lights, dome, haze, exposure, bloom strength, grade,
// window occupancy and lamp pools each frame; `?sky=` pins a phase (QA).
const skyCycle = new SkyCycle(
  {
    rig: skyRig,
    dome: skyDome,
    streetlights,
    renderer,
    bloom: bloomPass,
    grade: gradePass,
  },
  parseSkyParam(window.location.search),
);
// Street-level neon (S2): marquees, billboards, strips, spill — one shared
// Building[] again, so signage dresses exactly the rendered facades.
const signage = new Signage(city.cityBuildings, welcome.seed);
scene.add(signage.group);
// Cosmetic street traffic — pure function of the synced server clock, so
// every client (late joiners included) sees identical cars. Zero netcode.
// A1: plus the pickup taxis' slots (posed by CityLife below), same draw.
const traffic = new Traffic(welcome.seed, PICKUP_TAXIS);
scene.add(traffic.mesh);
// L6 headlights: soft cones in the haze + warm pools on the asphalt, lit from
// the cars Traffic placed this frame. Two additive draws for the whole city.
const headlights = new Headlights(traffic.capacity);
scene.add(headlights.cones, headlights.pools);
// L2 movers: cranes, helicopters, the blimp. Poses are the SAME pure function
// of (seed, server clock) the crash check uses, so what you see is what you
// can hit — and nothing about them is ever streamed.
// L10: plus this room's news heli — the server authors its route from kill
// sites; the welcome hands a late joiner the current one, `newsHeli` the rest.
const moverField = withNewsHeli(
  generateMovers(welcome.seed, city.cityBuildings),
  welcome.seed,
);
if (moverField.news && welcome.newsHeli) {
  moverField.news.target = welcome.newsHeli.target;
  moverField.news.prev = welcome.newsHeli.prev;
}
socket.events.onNewsHeli = (msg) => {
  if (moverField.news) setNewsTarget(moverField.news, msg.target);
};
const movers = new Movers(moverField);
scene.add(movers.rig, movers.hulls, movers.rotors);
// One additive point cloud shared by every L2 light: crane warning beacons,
// aircraft nav lights AND firework sparks. That merge is what keeps the whole
// L2 spectacle inside its draw-call budget.
const moverLights = new MoverLights();
scene.add(moverLights.points);
// L5/T2 elevated trains: every line's viaduct, stations and trains on both
// tracks, from the same movers field the crash check and the bots use (one
// InstancedMesh; lamps, canopy lights and sparks go into moverLights). The
// viaducts are static and drawn from frame one; the cars wait for the server
// clock like every mover.
const train = new TrainRenderer(moverField.trains ?? []);
scene.add(train.mesh);
/** T2: planes that can draw a train's horn this frame (yours + remotes). */
const hornPlanes: Vec3[] = [];
// N1 nature: night parks, landmark forecourts, street trees, hoardings. One
// pure seam feeds this renderer AND the crash check, so a tree is solid
// exactly where it is drawn (street trees excepted — lamp-pole height).
const nature = natureFor(welcome.seed, city.cityBuildings);
const natureIndex = buildNatureIndex(nature);
// F5 corner speed manager: the same solids the crash check reads, plus every
// hole's clear corridor (H1 holes and the river underpasses), built once.
const cornerWorld: CornerWorld = {
  buildings: city.cityBuildings,
  index: city.cityIndex,
  nature: natureIndex,
  movers: moverField,
  corridors: holeCorridors([
    ...cityHoles(city.cityBuildings),
    ...bridgeSpans(),
  ]),
};
// H2 hole assist: the silent centering nudge reads every hole (and river
// underpass) and the same city the crash check does. State is per frame.
const assistWorld: AssistWorld = {
  spans: [...cityHoles(city.cityBuildings), ...bridgeSpans()],
  buildings: city.cityBuildings,
  index: city.cityIndex,
};
const holeAssist = createHoleAssist();
const holeAssistWant = createHoleAssist();
const assistDir: Vec3 = { x: 0, y: 0, z: 0 };
const assistStickOut = { turn: 0, pitch: 0 };
const natureRenderer = new NatureRenderer(nature);
scene.add(natureRenderer.group);
// L11 river: embankment walls, bridges, the reflecting water and the boats.
// Its solids (decks, walls, boats) collide through hitsGround/the movers, so
// this is drawing only — updated on the same latched clock as the movers.
const river = new RiverRenderer(welcome.seed, city.cityBuildings);
scene.add(river.group);
// L9 moving nature: lit spray from the plaza ponds (pure ballistic function
// of the synced clock; one Points, drawn only near a pond). Tree sway lives
// in natureRenderer's crown shader; bird scatter in birds.update below.
const fountains = new Fountains(nature.ponds);
scene.add(fountains.points);
const fireworks = new Fireworks(welcome.seed);
const searchlights = new Searchlights(city.cityBuildings);
scene.add(searchlights.mesh);
// S1: the city's jumbotrons + headline tickers (one draw), told what to say
// by game/headlines.ts from the room's broadcasts (fed in onDeath/onScores).
const jumbotrons = new Jumbotrons(city.cityBuildings, renderer);
scene.add(jumbotrons.mesh);
// L10 drone show: points in the shared MoverLights cloud (zero draw calls).
const droneShow = new DroneShowRenderer(welcome.seed);
const birds = new Birds(welcome.seed);
scene.add(birds.points);
/** L9: planes the flocks react to, refilled per frame (no per-frame array). */
const birdPlanes: Vec3[] = [];
// L1 living streets — the micro tier. Client-only, non-collidable, and gated
// on camera altitude (100 → 140 m): four extra draw calls at street level and
// literally zero above the band, where a 1.8 m figure would be sub-pixel.
// generateCity hands back a FLAT Building[] and its blockKey is private to
// common/, so the client buckets by block itself, once.
const buildingsByBlock = new Map<number, Building[]>();
for (const b of city.cityBuildings) {
  const key =
    Math.floor(b.x / BLOCK_PITCH) * 1000 + Math.floor(b.z / BLOCK_PITCH);
  const bucket = buildingsByBlock.get(key);
  if (bucket) bucket.push(b);
  else buildingsByBlock.set(key, [b]);
}
const pedestrians = new Pedestrians(welcome.seed);
scene.add(pedestrians.mesh);
// A1 "full of life": riders, hailers, crossers, groups, joggers, dogs, carts,
// bus stops, performers, balcony and terrace people — ONE instanced draw —
// and laundry, facade flags and pigeons — ONE baked draw. Pure functions of
// (seed, server clock); see citylife.ts and facade-life.ts.
const cityLife = new CityLife(city.cityBuildings, welcome.seed);
scene.add(cityLife.mesh);
const facadeLife = new FacadeLifeRenderer(city.cityBuildings, welcome.seed);
scene.add(facadeLife.mesh);
// H2 hole decor: interiors and approach chevrons for every hole, one draw.
const holeDecor = new HoleDecorRenderer(city.cityBuildings);
scene.add(holeDecor.mesh);
// G1 street-level detail: benches, bins, hydrants, shelters, racks, booths,
// carts and parked cars in ONE instanced rig (+1 draw call); the fine road
// and sidewalk paint lives in the ground shader (street-paint.ts). All of it
// non-solid (the ≤ 3 m street-level exception). Built before Steam, whose
// cloud also carries the food carts' steam.
const streetFurniture = new StreetFurniture(
  welcome.seed,
  buildStreetDetailContext(
    welcome.seed,
    buildingsByBlock,
    cityHoles(city.cityBuildings),
    moverField.trains ?? [],
  ),
);
scene.add(streetFurniture.mesh);
streetFurniture.setEnabled(renderOpts.street);
const steam = new Steam(
  buildingsByBlock,
  welcome.seed,
  streetFurniture.cartSteamVents,
  MAX_CART_VENTS_PER_BLOCK,
);
scene.add(steam.points);
const signals = new Signals(welcome.seed);
scene.add(signals.mesh);
const constructionSparks = new ConstructionSparks(welcome.seed);
scene.add(constructionSparks.points);
/** Dev/QA switch (`?micro=0`, or __ab.setMicro): the perf A/B control. */
let microOn = renderOpts.micro;
/** The block __ab.micro() samples — fixed, so two tabs compare the same city. */
const MICRO_SAMPLE_BLOCK = { bx: 5, bz: 5 } as const;
const explosions = new Explosions();
scene.add(explosions.group);
const sparks = new Sparks();
scene.add(sparks.points);
// U1: a round glancing off a spawn shield — blue-white, never the hit spray.
const shieldSparks = new Sparks(0xbfe8ff);
scene.add(shieldSparks.points);
const smoke = new SmokeTrails();
scene.add(smoke.points);
// --- L1 reactive city (ANGE-WCQNFJ) ---
// Server-accepted city events (gunfire near buildings, deaths — coalesced on
// the server, replayed in the welcome) drive car alarms, woken windows, smoke
// columns and responders; snapshot low passes scatter the crowd; planes in
// range pull the searchlights. One Points draw (the smoke) — everything else
// rides traffic/signals/pedestrians/searchlights/building shader. Fed below in
// onSnapshot/onRespawn and evaluated per frame before traffic.update.
const reactor = new CityReactor(city.cityBuildings);
scene.add(reactor.points);
reactor.ingest(welcome.cityEvents ?? []);
socket.events.onCityEvent = (event) => reactor.ingest([event]);
/** Planes the searchlights track this frame (reused, no per-frame array). */
const trackedPlanes: { x: number; y: number; z: number }[] = [];
/** QA-only fixed camera (`__ab.qaCamera`): canonical eye + look-at, applied
 * just before the render so a capture can hold one viewpoint through a
 * death, the kill-cam and the respawn. Null = the normal chase camera. */
let qaView: { eye: Vec3; at: Vec3 } | null = null;
/** QA-only (`__ab.qaReactionClock`): evaluate the city's reactions at this
 * server time instead of the render clock, so a capture on a slow software
 * renderer can show "event + 2 s" exactly. Null = the render clock. */
let qaReactAt: number | null = null;
/**
 * QA-only (`__ab.pinWorld`, O4): the WORLD clock pinned to a server time,
 * then advanced by each frame's sim step. Everything that renders on
 * the latched `renderMs` — sky cycle, weather, traffic, signage, living
 * windows, movers and the news heli, train, drones, airliners, birds,
 * fireworks, storm strikes, reactions and the crash check — then shows the
 * same world on every pass of the perf harness. Remote planes keep the real
 * network clock. Meant for an empty, kill-free room: events the server
 * stamps (kills, news-heli retargets) are not re-timed. Null = the render
 * clock; clearing it may step the world back, which the strike feed and the
 * smoothed clocks already resync from.
 */
let qaWorld: { ms: number; frameMs: number | null } | null = null;
/** The world clock the frame loop rendered at last (pinned or synced). */
const worldTime = (): number | null =>
  qaWorld !== null ? qaWorld.ms : socket.renderTime();
// ST2 storm: bolts + flash from the shared schedule — zero strike netcode;
// every client computes the identical storm from (seed, synced clock).
const storm = new StormRenderer(city.cityBuildings);
scene.add(storm.group, storm.flashLight);
const strikeFeed = new StrikeFeed(welcome.seed);
// The deck everyone shares: seeded layout, drifting on the synced clock.
const clouds = new CloudDeck(welcome.seed);
scene.add(clouds.group);
// The storm's neutral radar: strikes reveal nearby planes to EVERYONE.
const reveals = new StormReveals();
// L4 weather: one seeded cycle on the synced clock (clear until sync) drives
// the rain streaks, wet ground/facades, haze (via storm.atmosphere) and the
// rain bed (through L2's ambience). `weatherShift` is the QA pin (__ab.weather) — an offset, so the
// pinned sky keeps its ripples and drift moving.
const weather = new WeatherClock(welcome.seed);
const rain = new Rain();
scene.add(rain.mesh);
let weatherShift = 0;
// Distance-delayed rumbles: flash now, thunder wrapDistance/340 later.
const thunder = new ThunderSchedule();
/** Recent strikes as consumed from the schedule (QA hook — two tabs must
 * report identical entries, since the schedule is shared, not streamed). */
const strikeLog: { timeMs: number; x: number; z: number }[] = [];

const plane = buildPlaneMesh();
scene.add(plane);

// Night visibility (ANGE-L7F2OS): every plane's aviation lights share one
// Points draw call, every plane's wingtip ribbons one mesh — planes light
// themselves, the world stays dark.
const planeLights = new PlaneLights();
scene.add(planeLights.points);
const planeTrails = new PlaneTrails();
scene.add(planeTrails.mesh);

socket.sendPing(); // W1: the city and its dressing are built
// --- Remote planes ---
const remotes = new RemotePlanes(
  scene,
  socket.selfId,
  planeLights,
  planeTrails,
);
remotes.setRoster(welcome.roster);

// --- Combat: guns, bullets, tracers, HUD chrome ---
const guns = new Guns();
const bullets = new Bullets();
const tracers = new Tracers();
scene.add(tracers.group);
const audio = new GameAudio();
/** M6: the players' volume sliders, as gains (stored before the context
 * exists; GameAudio applies them as its buses are built). */
const applyVolumes = (): void =>
  audio.setVolumes({
    master: volumeGain(settings.master),
    engine: volumeGain(settings.engine),
    voice: volumeGain(settings.voice),
  });
applyVolumes();
// L2 city soundscape: traffic, horns, sirens, plaza music, wind and tunnel
// echo — procedural, built once into GameAudio's ducked sfx bus.
const ambience = new CityAmbience(
  audio,
  welcome.seed,
  cityHoles(city.cityBuildings),
);
// T2: wheel clatter over the rail joints and the horn, on the same mix bus.
const trainAudio = new TrainAudio(audio);
// A1: the nearest street performer's guitar, on the same city bus.
const busker = new Busker(ambience);
const buskerAt = { x: 0, y: 0, z: 0 };
const hud = new Hud();
const minimap = new Minimap(city.cityBuildings);
const edgeMarkers = new EdgeMarkers();
const leadIndicator = new LeadIndicator();
// One soft tick on ACQUIRING a firing solution, never while it holds.
const solutionTone = new SolutionTone();
const markerScratch = new THREE.Vector3();
// U1: getting shot — red edge flash, a thud, and an arc toward the shooter.
const damageIndicator = new DamageIndicator();
// U1 haptics: Android vibrates, iOS has no API (feature-detected no-op).
// A never-touched setting (null) means "on for a touch device".
const haptics = new Haptics(navigator, settings.haptics ?? coarsePointer());
// M8 auto-fire: pulls its own trigger on the lead computer's firing
// solution. Same never-touched rule: on for a touch device, off for a mouse.
let autoFireOn = settings.autoFire ?? coarsePointer();
const autoFire = createAutoFire();
/** Last frame's lead solution (the lead computer runs after the render). */
let leadSolution = false;
const viewDir = new THREE.Vector3();
/** A shooter's live position for their arc; null once they're gone. */
const shooterLivePos = (id: string) => remotes.poseOf(id)?.pos;
const hpBar = new HpBarTracker();
const hpBarSprite = new HpBarSprite();
scene.add(hpBarSprite.sprite);
const killFeed = new KillFeed();
const scoreboard = new Scoreboard(socket.selfId);
scoreboard.setRoster(welcome.roster);
scoreboard.setScores(welcome.scores);
showOwnScore(welcome.scores);
// The room's shared bot count (ANGE-6STDNN): seeded from the welcome so a
// late joiner's bar opens where the room already is.
const botBar = new BotBar(welcome.botTarget);
botBar.onClaim = (count) => socket.sendSetBots(count);
scoreboard.bindBotBar(botBar);
// M2: no Tab key on a phone — a minimap tap pins the scoreboard (touch only).
scoreboard.bindTapToggle(document.getElementById("minimap") as HTMLElement);
// U3: first-life hints, the touch coach marks and the storm notice. Starts
// with the first rendered frame (bottom of the file).
const coach = new Coach(isTouch);
whenTouch(() =>
  coach.bindTouchAim(document.getElementById("touch-layer") as HTMLElement),
);

/** id → name/isBot for feed + radio lines (self included; remotes tracks the
 * others too). isBot gates whether the VOICE may speak the callsign. */
const players = new Map<string, { name: string; isBot: boolean }>(
  welcome.roster.map((r) => [r.id, { name: r.name, isBot: r.isBot ?? false }]),
);
const nameOf = (id: string): string => players.get(id)?.name ?? "???";
const isBotOf = (id: string): boolean => players.get(id)?.isBot ?? false;
/** S1: the name-guarded label a WORLD screen may show (bot callsign or the
 * pilot's alias — never free text; see game/headlines.ts). */
const screenLabel = (id: string): string => pilotLabel(id, players.get(id));

// --- Radio comms: one channel, priority queue, voice + ticker (client-only) ---
// The pre-rendered voice bundle (tools/gen-radio-voices.sh): asset id → url,
// fetched eagerly by RadioVoice and decoded once the AudioContext runs.
const radioAssetUrls = Object.fromEntries(
  Object.entries(
    import.meta.glob("../assets/radio/*.ogg", {
      eager: true,
      query: "?url",
      import: "default",
    }) as Record<string, string>,
  ).map(([path, url]) => [
    path.replace(/^.*\//, "").replace(/\.ogg$/, ""),
    url,
  ]),
);
const radio = new RadioQueue();
const radioVoice = new RadioVoice(audio, radioAssetUrls);
const comms = new CommsTicker();
const ambient = new AmbientChatter(welcome.seed, performance.now());
const RADIO_VOICE_KEY = "ab-radio-voice";
let radioVoiceOn = readStored(RADIO_VOICE_KEY) !== "off";
const saveRadioVoice = (on: boolean): void => {
  radioVoiceOn = on;
  writeStored(RADIO_VOICE_KEY, on ? "on" : "off");
};
// The HUD entry and the M6 settings panel both flip it; the setter keeps
// the HUD entry truthful when the panel does.
const paintRadioToggle = hud.bindRadioToggle(radioVoiceOn, saveRadioVoice);
/** Armed while HP is healthy; fires once per drop below LOW_HP_CALLOUT. */
let lowHpArmed = true;
/** Recent on-air lines (QA hook — headless runs can't hear the TTS). */
const radioLog: {
  at: number;
  speaker: string;
  ticker: string;
  voice: string;
}[] = [];
const say = (c: Callout): boolean => radio.enqueue(c, performance.now());
const botCallsigns = (): string[] => {
  const out: string[] = [];
  for (const p of players.values()) if (p.isBot) out.push(p.name);
  return out;
};

// --- Simulation state ---
const input = new FlightInputSource();
const chase = new ChaseCamera();
// L11b spring arm: the eye never sits inside a building, the ground, the
// river's decks and bank walls, or a mover at the latched render clock
// (trees excepted — a canopy flick would pump the arm).
let chaseMoversMs: number | null = null;
chase.solid = (p, r) =>
  touchesSolid(
    p,
    r,
    city.cityBuildings,
    city.cityIndex,
    moverField,
    chaseMoversMs,
  );
// Hold-E free-look: pure client camera state, never streamed (B2).
let freelook = createFreeLook();
// Hold-right-click aim zoom: same deal — display + input shaping only.
let zoom = createZoom();
// Mouse-aim instructor (F1): client-only, its output is ordinary input.
let instructor = createInstructor();
let aimMode = input.aimMode();
/** Last frame's smoothed cursor — the free-look drag latch diffs against it. */
let cursorPrev = input.cursorNdc();
/** Whether the pipper sits on the cursor this frame (HUD converged state). */
let aimConverged = false;
/** The pipper-to-cursor angle this frame, rad (F6 QA). */
let aimGap = 0;
/** The FOV the instructor last read the cursor through (latch reference). */
let aimFovPrev = BASE_FOV;
// Hold-SPACE boost (F2): the local half of the shared energy model. The
// server mirrors it from the edges we send, so `boostSent` tracks what the
// server was last told.
const boostKey = new BoostKey();
let boost = createBoost(performance.now());
let boostSent = false;
// M1 touch controls: only once the device is touch (M2's whenTouch). The
// thumbs drive the SAME seams as the mouse and keyboard — the aim point is
// `input`'s cursor, FIRE is `guns`' trigger, BOOST is `boostKey`'s edge — so
// the frame loop below has no touch branch beyond the throttle servo call.
let touchControls: TouchControls | null = null;
whenTouch(() => {
  touchControls = new TouchControls({ input, guns, boostKey, scoreboard });
});
/** Extra vertical FOV at full boost speed, degrees — the speed kick. */
const BOOST_FOV_KICK = 9;
/** 0 at ≤ MAX_SPEED, 1 at full boost speed. */
const overspeedOf = (speed: number): number =>
  Math.min(1, Math.max(0, (speed - MAX_SPEED) / (BOOST_MAX_SPEED - MAX_SPEED)));
/** The vertical FOV the render writes: zoom, plus the boost kick and the F6
 * speed FOV (jet-camera.ts) un-zoomed. The instructor reads the cursor
 * through the same one. */
const viewFov = (z: number, overspeed: number, speed: number): number =>
  zoomFov(z) + (BOOST_FOV_KICK * overspeed + speedFov(speed)) * (1 - z);
let flight: FlightState = createFlightState(
  welcome.spawn.pos,
  welcome.spawn.yaw,
);
// Server's spawn airspeed; the throttle stays FULL (F5, createFlightState).
flight = { ...flight, speed: welcome.spawn.speed };
chase.snapTo(flight);

/** F5: the corner manager's rate-limited speed ceiling, m/s (MAX = none). */
let cornerCap = MAX_SPEED;
/** F6: the yaw rate this frame's input commands, rad/s (+ = left) — what
 * the chase camera leans into (jet-camera.ts). */
let leadYawRate = 0;
let alive = true;
let killCamTargetId: string | null = null;
// Server-said combat state about self (snapshots), kept for HUD + QA.
let selfHp = MAX_HP;
/** The own plane's control-surface commands, from the last flight step. */
let ownControls: ControlDeflection = NEUTRAL_CONTROLS;
let selfProt = true;
/** W2: our away took effect server-side (awayStarted) — its return is
 * answered with a respawn. */
let awayStarted = false;
/** W2: since when (performance.now()) poses are held for that return
 * respawn, or null. Stale poses from where the tab froze would only trip the
 * server's re-sync against the new spawn. */
let awaitingReturn: number | null = null;
/** Longest the hold may last before posing resumes anyway, ms. */
const RETURN_HOLD_MAX_MS = AWAY_MIN_MS + 2000;
let lastScores: ScoreEntry[] = welcome.scores;
/** S1: the TOP PILOT the leader spot follows (null: nobody has a kill). */
let leaderId: string | null = null;
/** S1: crown the TOP PILOT from the room's tallies (identical on every
 * client) and hand the jumbotrons their card. Runs on events only. */
function refreshLeader(): void {
  const top = topPilot(lastScores);
  leaderId = top?.id ?? null;
  jumbotrons.setLeader(
    top && {
      id: top.id,
      label: screenLabel(top.id),
      livery: liveryFor(top.id),
      kills: top.kills,
      deaths: top.deaths,
    },
  );
}
refreshLeader();
let lastDeath: {
  victimId: string;
  killerId: string | null;
  cause: DeathMsg["cause"];
} | null = null;
let remoteFireSide = 1;

const fadeEl = document.getElementById("fade") as HTMLDivElement;
const hudEl = document.getElementById("hud") as HTMLDivElement;

/** Instant black, then ease back in — death and respawn both get the beat. */
function flashFade(): void {
  fadeEl.classList.add("dead");
  requestAnimationFrame(() =>
    requestAnimationFrame(() => fadeEl.classList.remove("dead")),
  );
}

/** H2: refresh the hole assist's target for this frame (zero while it is
 * stood down) and glide the applied bias toward it. */
function stepAssist(off: boolean, dt: number): void {
  if (off) {
    holeAssistWant.yaw = 0;
    holeAssistWant.pitch = 0;
  } else {
    holeAssistTarget(flight.pos, assistDir, assistWorld, holeAssistWant);
  }
  stepHoleAssist(holeAssist, holeAssistWant, dt);
}

/** A fresh plane starts with no assist bias. */
function resetAssist(): void {
  holeAssist.yaw = 0;
  holeAssist.pitch = 0;
}

/** Freeze into the kill-cam; the server's respawn message ends it. A local
 * crash enters first; the server's death message then refines the headline
 * (credit, storm) on the same countdown. */
function enterDeath(killerId: string | null, cause: DeathMsg["cause"]): void {
  // Kill-cam owns the camera — force-exit free-look and the zoom instantly.
  freelook = createFreeLook();
  zoom = createZoom();
  instructor = createInstructor();
  resetAssist();
  hud.setFreeLook(false);
  killCamTargetId = killerId;
  hud.showKillCam(
    deathLabel(cause, killerId === null ? null : nameOf(killerId)),
    performance.now(),
  );
  setBoostBurning(false, performance.now());
  damageIndicator.clear();
  if (!alive) return;
  alive = false;
  haptics.death(); // after the guard: a crash + its death message buzz once
  plane.visible = false;
  planeTrails.clear(socket.selfId);
  bullets.clearOwn();
  flashFade();
}

function respawnSelf(spawn: SpawnState): void {
  planeTrails.clear(socket.selfId); // respawn teleports — no streak
  interruptQuality(); // O3: a transient
  flight = createFlightState(spawn.pos, spawn.yaw);
  flight = { ...flight, speed: spawn.speed }; // throttle stays FULL (F5)
  cornerCap = MAX_SPEED; // a fresh plane starts unbraked
  chase.snapTo(flight);
  instructor = createInstructor();
  resetAssist();
  alive = true;
  killCamTargetId = null;
  plane.visible = true;
  hud.hideKillCam();
  damageIndicator.clear();
  guns.reset(performance.now());
  // A fresh plane is protected until a snapshot says otherwise: the last
  // life's `false` must not let auto-fire spend the new protection.
  selfProt = true;
  boost = createBoost(performance.now()); // fresh plane, full gauge
  lowHpArmed = true; // fresh plane, fresh "I'm hit" edge
  flashFade();
}

/** Start or end the local burn and tell the server's mirror on any change.
 * A start the energy can't pay for leaves `boost` idle — nothing is sent. */
function setBoostBurning(on: boolean, now: number): void {
  boost = on ? startBoost(boost, now) : stopBoost(boost, now);
  if (boost.active === boostSent) return;
  boostSent = boost.active;
  socket.sendBoost(boostSent);
  if (boostSent) audio.boostCue();
}

/** Cosmetic tracer burst for a remote's validated shot. */
function remoteFired(id: string): void {
  const pose = remotes.poseOf(id);
  if (!pose) return;
  remoteFireSide = -remoteFireSide;
  const quat = new THREE.Quaternion(
    pose.quat.x,
    pose.quat.y,
    pose.quat.z,
    pose.quat.w,
  );
  const muzzle = new THREE.Vector3(
    remoteFireSide * 3.5,
    0,
    -0.8,
  ).applyQuaternion(quat);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
  const speed = BULLET_SPEED + pose.speed;
  const origin = {
    x: pose.pos.x + muzzle.x,
    y: pose.pos.y + muzzle.y,
    z: pose.pos.z + muzzle.z,
  };
  bullets.spawn(
    -1,
    origin,
    { x: fwd.x * speed, y: fwd.y * speed, z: fwd.z * speed },
    true,
  );
  tracers.flash(origin, performance.now());
  audio.remoteGunshot(origin, flight.pos, flight.yaw);
}

// --- Server events ---
socket.events.onSnapshot = (snap) => {
  remotes.ingest(snap);
  reactor.observeSnapshot(snap, socket.selfId); // L1 low passes + own track
  const self = snap.players.find((p) => p.id === socket.selfId);
  if (self) {
    selfHp = self.hp;
    selfProt = self.prot;
    hud.setHp(self.hp);
    hud.setProtected(self.prot);
    // Regen back above the threshold re-arms the "I'm hit" callout.
    if (self.hp >= LOW_HP_CALLOUT) lowHpArmed = true;
  }
};
socket.events.onPlayerJoined = (player) => {
  players.set(player.id, {
    name: player.name,
    isBot: player.isBot ?? false,
  });
  remotes.playerJoined(player);
  scoreboard.playerJoined(player);
  say(checkInCallout(player.name, player.isBot ?? false));
  refreshLeader(); // a bot's callsign label needs its roster entry
};
socket.events.onPlayerLeft = (id) => {
  say(offStationCallout(nameOf(id), isBotOf(id)));
  remotes.playerLeft(id);
  scoreboard.playerLeft(id);
  players.delete(id);
};
socket.events.onFired = (id) => remoteFired(id);
socket.events.onDamage = (msg) => {
  if (msg.shooterId === socket.selfId) {
    hud.hitConfirm(performance.now());
    // OUR damage only — another player's hits never raise our target bar.
    if (msg.targetId !== socket.selfId) {
      hpBar.recordDamage(msg.targetId, msg.hp, performance.now());
    }
  }
  if (msg.targetId === socket.selfId) {
    // Read before the write below: the flash scales by what this hit took.
    const lost = selfHp - msg.hp;
    selfHp = msg.hp;
    hud.setHp(msg.hp);
    if (alive) {
      const now = performance.now();
      // A snapshot (or regen) can land between hits and eat the difference.
      const dmg = lost > 0 ? lost : BULLET_DAMAGE;
      const shooterPos =
        msg.shooterId === socket.selfId
          ? null
          : remotes.poseOf(msg.shooterId)?.pos;
      damageIndicator.hit(msg.shooterId, shooterPos, dmg, now);
      audio.damageThud(now);
      haptics.damage(now);
    }
    radio.noteCombat(performance.now());
    if (lowHpArmed && msg.hp < LOW_HP_CALLOUT) {
      lowHpArmed = false;
      say(hitCallout(name));
    }
  }
};
socket.events.onDeath = (msg) => {
  // O4: the cause too, so the perf harness can say WHY a segment died.
  lastDeath = {
    victimId: msg.victimId,
    killerId: msg.killerId,
    cause: msg.cause,
  };
  // Grab the victim's position before setDead clears it (self = own plane).
  const victimPos =
    msg.victimId === socket.selfId
      ? flight.pos
      : remotes.poseOf(msg.victimId)?.pos;
  if (victimPos) {
    audio.explosion(victimPos, flight.pos, flight.yaw);
    explosions.explode(victimPos, performance.now());
    // Storm kill: the bolt comes down ON the victim (kill-cam length) with
    // an immediate hard crack — the one strike that isn't on the schedule.
    if (msg.cause === "storm") {
      storm.boltAt(victimPos, performance.now());
      audio.thunder(
        Math.max(0.5, thunderGain(wrapDistance(victimPos, flight.pos))),
        true,
      );
    }
  }
  // S1: the city's screens. The tallies held here are the pre-death ones
  // (the server sends each death before its scores), the same on every
  // client — the headline's verb seeds from them.
  const subject = replaySubject(msg);
  jumbotrons.addKill({
    headline: killHeadline(
      msg,
      screenLabel,
      lastScores.find((e) => e.id === msg.victimId)?.deaths ?? 0,
    ),
    feed: feedLine(msg, screenLabel),
    caption: subject.caption,
    subjectLabel: screenLabel(subject.id),
    livery: liveryFor(subject.id),
  });
  killFeed.add(
    msg.killerId === null ? null : nameOf(msg.killerId),
    nameOf(msg.victimId),
    msg.cause,
    msg.killerId === socket.selfId || msg.victimId === socket.selfId,
  );
  if (msg.killerId === socket.selfId && msg.victimId !== socket.selfId) {
    hud.killConfirm(performance.now());
    haptics.kill();
    audio.killConfirm();
  }
  hpBar.clear(msg.victimId); // never float a stale bar over a respawn
  if (msg.victimId === socket.selfId) {
    enterDeath(msg.killerId, msg.cause);
    // U3: the first storm death earns one "stay below" notice on respawn.
    if (msg.cause === "storm") coach.noteStormDeath();
    // M5: the first life is over ("after the first match" in a drop-in
    // game) — the kill-cam pause is when an install offer intrudes least.
    phoneFullscreen.onFirstLifeOver();
  } else remotes.setDead(msg.victimId);
  // Radio: the victim's mayday from us, or the killer's "splash one".
  if (msg.victimId === socket.selfId) {
    radio.noteCombat(performance.now());
    say(maydayCallout(name));
  } else if (msg.killerId === socket.selfId) {
    say(ownKillCallout(name));
  } else if (msg.killerId !== null) {
    say(splashCallout(nameOf(msg.killerId), isBotOf(msg.killerId)));
  }
};
socket.events.onRespawn = (msg) => {
  // Fresh spawn, fresh trail — a rebased teleport would smear smoke 1 km.
  smoke.clear(msg.id);
  if (msg.id === socket.selfId) reactor.clearSelfTrack(); // L1: track jumps
  if (msg.id === socket.selfId) {
    respawnSelf(msg.spawn);
    // W2: once visible, this is (or supersedes) the return respawn poses
    // were held for. A kill-cam respawn landing while still hidden is not:
    // the server's own return respawn follows the away.
    if (!document.hidden) {
      awayStarted = false;
      awaitingReturn = null;
    }
  } else remotes.respawn(msg.id);
};
socket.events.onAwayStarted = () => {
  awayStarted = true;
  // Already back (the ack crossed our `away: false`): hold for the respawn.
  if (!document.hidden) awaitingReturn = performance.now();
};

/**
 * W2: back as the same player after a dropped socket. The room moved on
 * meanwhile: reconcile who is here (silently — the radio already heard
 * nothing of the gap), take the server's scores and bot count, and fly the
 * fresh spawn, since the session restarted server-side. City events and the
 * news heli belong to the room, so they are re-seeded only if it changed.
 */
let currentRoomId = welcome.roomId;
function applyResume(w: WelcomeMsg): void {
  const here = new Set(w.roster.map((r) => r.id));
  for (const id of [...players.keys()]) {
    if (id === socket.selfId || here.has(id)) continue;
    remotes.playerLeft(id);
    scoreboard.playerLeft(id);
    players.delete(id);
  }
  for (const r of w.roster) {
    if (players.has(r.id)) continue;
    players.set(r.id, { name: r.name, isBot: r.isBot ?? false });
    remotes.playerJoined(r);
    scoreboard.playerJoined(r);
  }
  lastScores = w.scores;
  refreshLeader();
  scoreboard.setScores(w.scores);
  showOwnScore(w.scores);
  botBar.resync(w.botTarget);
  if (w.roomId !== currentRoomId) {
    currentRoomId = w.roomId;
    reactor.ingest(w.cityEvents ?? []);
    if (moverField.news && w.newsHeli) {
      moverField.news.target = w.newsHeli.target;
      moverField.news.prev = w.newsHeli.prev;
    }
  }
  smoke.clear(socket.selfId);
  reactor.clearSelfTrack();
  respawnSelf(w.spawn);
  awayStarted = false;
  awaitingReturn = null;
  hud.setReconnecting(false);
}
socket.events.onReconnecting = () => hud.setReconnecting(true);
socket.events.onResumed = applyResume;
/** U2: the own row of a `score` broadcast drives the HUD's K/D readout. */
function showOwnScore(scores: ScoreEntry[]): void {
  const own = scores.find((e) => e.id === socket.selfId);
  hud.setScore(own?.kills ?? 0, own?.deaths ?? 0);
}
socket.events.onScores = (scores) => {
  lastScores = scores;
  refreshLeader();
  scoreboard.setScores(scores);
  showOwnScore(scores);
};
socket.events.onBotsConfig = (msg) => {
  // The server is the only authority on this value — including for the
  // player who just dragged, whose bar has been showing a preview.
  botBar.applyServer(msg.count, msg.byName);
  scoreboard.refreshBotBar();
  // Ticker only, never the voice: byName is free text, and the radio's
  // name guard (game/callouts.ts) exists precisely to keep it out of TTS.
  comms.add("NET", `${msg.byName} set bots to ${msg.count}`);
};

// --- Perf instrumentation (P1) ---
// One meter feeds the HUD line, the dev perf overlay, `__ab.perf()` and the
// headless harness, so those four can never disagree. A second, short meter
// feeds the resolution controller and is CLEARED on every ratio change —
// otherwise the window still holds frames rendered at the old ratio and the
// controller double-steps on stale evidence.
const frames = new FrameMeter();
/** M3: pre-render JS per frame over the harness's window (`__ab.jsStats`). */
const jsFrames = new FrameMeter();
const resFrames = new FrameMeter(WINDOW_FRAMES * 3);
// GPU-side cost of the same frames, when the harness asked for it. Null on
// drivers without the timer-query extension — a missing number, never an
// error (client/src/render/gputimer.ts).
// 64, not 16: begin() has to skip a frame whenever every query is still in
// flight, and the pool drains precisely when the GPU is behind — i.e. on the
// expensive frames p95/p99/worst are made of. A deeper pool plus the skip
// COUNT (surfaced below) is what makes the tail believable.
const gpuTimer = renderOpts.gpuTimer
  ? GpuTimer.create(renderer.getContext(), 64)
  : null;
const gpuFrames = new FrameMeter();
/** How often the resolution controller looks; it is rate-limited past this. */
const RES_EVAL_MS = 250;
let nextResEvalAt = 0;
/**
 * Frames drawn in the first few seconds are not evidence about this machine:
 * they pay for shader compiles, pipeline-state creation and texture uploads,
 * none of which recur. Without this grace the controller's FIRST decision
 * lands inside that window on every client, latches a penalty nobody earned,
 * and (before the latch could be relaxed) kept it for the whole session.
 */
const RES_WARMUP_MS = 3000;
let resWarmupUntil = -1;
const perfHud = new PerfHud();
// `P` is a DEBUG key, not a player key: bound only in a dev build or when
// the URL asked for the overlay. A production visit registers no listener,
// so a player who presses P gets nothing (client/src/ui/perfhud.ts).
bindPerfHudKey(
  perfHud,
  perfHudKeyEnabled(import.meta.env.DEV, renderOpts.perfHud),
);
if (renderOpts.perfHud) perfHud.setOpen(true);

// --- O3 graphics quality ---
// The window's pre-render JS cost per frame — Auto's CPU-bound signal. Fed
// and cleared alongside resFrames, so both always describe the same frames.
const cpuFrames = new FrameMeter(WINDOW_FRAMES * 3);

/**
 * Hand a tier to every system whose cost depends on it and re-cap the
 * scaler. Each hook only flips visibility, counts or uniforms (quality.ts
 * rule 1), so this never compiles a shader. Both windows are dropped:
 * frames drawn under the old tier are not evidence about the new one.
 *
 * The scaler always loses its latch — a new tier must not inherit the
 * penalty the old one earned. A PICK (key, HUD, QA) restarts it at the new
 * tier's ceiling, so choosing High looks like High at once. An Auto DROP
 * (`keepRatio`) keeps the current ratio instead: restarting at the ceiling
 * would walk the very rungs that just missed, a second burst of dropped
 * frames, where a cleared latch lets the cheaper tier earn them back.
 */
function applyQualityTier(tier: QualityTier, keepRatio = false): void {
  qualityTier = tier;
  city.setQuality(tier);
  reactor.setQuality(tier);
  pedestrians.setQuality(tier);
  cityLife.setQuality(tier); // A1
  facadeLife.setQuality(tier); // A1
  holeDecor.setQuality(tier); // H2
  // M3: steam, signals and construction sparks stream in the tier's radius.
  steam.setQuality(tier);
  streetFurniture.setQuality(tier); // G1
  signals.setQuality(tier);
  constructionSparks.setQuality(tier);
  rain.setQuality(tier);
  headlights.setQuality(tier);
  signage.setQuality(tier);
  jumbotrons.setQuality(tier); // S1: Mobile shows the static LAST KILL card
  rooftopLife.setQuality(tier);
  roofClutter.setQuality(tier); // R2: fine roof dressing only
  natureRenderer.setQuality(tier);
  fountains.setQuality(tier);
  birds.setQuality(tier);
  airliners.setQuality(tier);
  facadeDetail.setQuality(tier);
  train.setQuality(tier); // T2: platform people, sparks, light range
  applyPostQuality();
  resLimits = limitsFor(tier);
  if (resAuto) {
    const fresh = autoResolution(performance.now());
    resolution = keepRatio
      ? { ...fresh, ratio: Math.min(resolution.ratio, fresh.ratio) }
      : fresh;
    applyPixelRatio(resolution.ratio);
  }
  resFrames.reset();
  cpuFrames.reset();
  hud.setQuality(qualitySetting, tier);
}

/**
 * M3: the post passes a tier (and a thermal level) keeps. `.enabled` only —
 * the composer sends the last ENABLED pass to screen, and no program
 * changes. `?grade=0` (gradePass null) stays off whatever the tier says.
 */
function applyPostQuality(): void {
  bloomPass.enabled = bloomOn(qualityTier, thermal.level);
  if (gradePass) gradePass.enabled = QUALITY_PROFILES[qualityTier].grade;
}

/** O3/M3: a transient (hidden tab, death, resize, teleport) — forget the
 * pressure runs of both Auto and the thermal step-down. */
function interruptQuality(): void {
  autoQuality = interruptAutoQuality(autoQuality);
  thermal = interruptThermal(thermal);
}

/** The player's (or QA's) pick. Re-picking Auto restarts it at its start
 * tier (High, or Mobile on a phone); any pick restarts the thermal level. */
function setQualitySetting(setting: QualitySetting, persist: boolean): void {
  qualitySetting = setting;
  thermal = createThermal(performance.now());
  if (setting === "auto") {
    autoQuality = createAutoQuality(performance.now(), autoStart);
  }
  // Storage blocked: the pick still applies for this session.
  if (persist) writeStored(QUALITY_STORAGE_KEY, setting);
  applyQualityTier(setting === "auto" ? autoQuality.tier : setting);
}

/** One adaptive-resolution tick (P1/O1), at RES_EVAL_MS after the warm-up. */
function stepScaler(now: number): void {
  const next = stepResolution(
    resolution,
    resFrames.tail(WINDOW_FRAMES),
    now,
    resLimits,
    tierMissMs(qualityTier), // M3: Mobile steers to 30 fps
  );
  // RATIO, not identity: the controller also advances clean-run
  // bookkeeping on ticks that move nothing, and treating those as a
  // change would reset the window every 250 ms — the controller would
  // then never hold a full window and never decide anything again.
  const moved = next.ratio !== resolution.ratio;
  resolution = next;
  if (moved) {
    applyPixelRatio(next.ratio);
    // Frames drawn at the previous ratio are no longer evidence about
    // this one — judging the new ratio on them double-steps the scaler.
    resFrames.reset();
    cpuFrames.reset();
  }
}

/**
 * One Auto tick, on the scaler's cadence and its window. Only a living,
 * visible player's frames are evidence (a kill-cam, a hidden tab and the
 * frames right after one are not the machine's steady state), and only a
 * FULL window is judged — the scaler empties it on every ratio change.
 */
function stepQuality(now: number): void {
  if (!alive || document.hidden) {
    interruptQuality();
    return;
  }
  const wall = resFrames.tail(WINDOW_FRAMES);
  if (wall.length < WINDOW_FRAMES) return;
  const cpu = [...cpuFrames.tail(WINDOW_FRAMES)].sort((a, b) => a - b);
  // M3: misses and the CPU-bound line are judged against the tier's budget.
  const share = missShare(wall, tierMissMs(qualityTier));
  const cpuMs = percentile(cpu, 0.5);
  const budgetMs = tierBudgetMs(qualityTier);
  if (autoQuality.tier === "mobile") {
    // Mobile has no tier below it: its rungs are thermal levels, which only
    // re-cap the scaler and drop bloom (render/quality.ts).
    const next = stepThermal(
      thermal,
      share,
      resolution.ratio,
      cpuMs,
      now,
      budgetMs,
    );
    const stepped = next.level !== thermal.level;
    thermal = next;
    if (stepped) applyQualityTier(qualityTier, true);
    return;
  }
  const next = stepAutoQuality(
    autoQuality,
    share,
    resolution.ratio,
    cpuMs,
    now,
    budgetMs,
  );
  const dropped = next.tier !== autoQuality.tier;
  autoQuality = next;
  if (dropped) applyQualityTier(next.tier, true);
}

applyQualityTier(qualityTier);
const cycleQuality = (): void =>
  setQualitySetting(nextQualitySetting(qualitySetting), true);
hud.bindQualityToggle(cycleQuality);
window.addEventListener("keydown", (e) => {
  if (e.code !== QUALITY_KEY || e.repeat) return;
  cycleQuality();
});

// --- Dev/QA hooks (used by the headless verification harness) ---
const perf = { frames: 0, ms: 0, fps: 0, frameMs: 0 };
declare global {
  interface Window {
    __ab?: {
      state: () => FlightState;
      teleport: (x: number, z: number, y?: number, yaw?: number) => void;
      perf: () => {
        fps: number;
        frameMs: number;
        drawCalls: number;
        smokePuffs: number;
      };
      /** P1: the full frame-time window — p50/p95/p99/worst + draw calls. */
      perfStats: () => FrameStats;
      /** M3: the same window's pre-render JS cost per frame (sim, streaming,
       * instance packing — the render call itself is not in it). */
      jsStats: () => FrameStats;
      /** Every frame time held, oldest first (harness histograms). */
      perfSamples: () => number[];
      /** GPU-only frame cost over the same window; null unless ?gputime=1. */
      gpuStats: () => FrameStats | null;
      /**
       * The GPU window's own per-frame samples, oldest first; null unless
       * ?gputime=1. The pair with perfSamples() is what tells a JS pause
       * apart from a GPU stall: a garbage collection or a long script shows
       * up ONLY in the wall samples, because the GPU was idle through it.
       *
       * NOT index-aligned with perfSamples(): a timer query resolves a
       * frame or two after the frame it measured, and a starved frame
       * (gpuStarved) is missing entirely. Compare the two as windows —
       * where in each a spike lands, how big — never sample by sample.
       */
      gpuSamples: () => number[] | null;
      /**
       * Frames the GPU timer could not measure since the last perfReset().
       * Non-zero means the tail of gpuStats() is missing its worst samples
       * and must not be quoted — see render/gputimer.ts.
       */
      gpuStarved: () => number | null;
      /** Drop the window — the harness calls this at each segment boundary. */
      perfReset: () => void;
      /** Live render config: pixel ratio, its limits, and the AA mode. */
      render: () => {
        aa: string;
        /** The `antialias` CONTEXT attribute — multisamples the default fb. */
        antialiasAttribute: boolean;
        /** Samples on the default framebuffer, which the scene never uses. */
        defaultFramebufferSamples: number;
        /** Samples on the target the scene ACTUALLY renders into. */
        sceneTargetSamples: number;
        pixelRatio: number;
        auto: boolean;
        floor: number;
        ceiling: number;
        hotRatio: number;
        drawingBuffer: { width: number; height: number };
        /** O4: the post chain (`?post=`) and the bloom chain's density. */
        post: PostMode;
        bloomDensity: number;
      };
      /** Pin the pixel ratio (a number) or hand it back to the controller. */
      setPixelRatio: (ratio: number | "auto") => void;
      /** O3: the graphics setting, the tier it resolves to, Auto's state and
       * the scaler ceiling the tier imposes. */
      quality: () => {
        setting: QualitySetting;
        tier: QualityTier;
        auto: AutoQualityState;
        ceiling: number;
        /** M3: the thermal step-down's state (level 0 = none). */
        thermal: ThermalState;
        /** M3: the post passes running now, and the budget steered to. */
        bloom: boolean;
        grade: boolean;
        budgetMs: number;
      };
      /** O3 QA: pick a setting for this session (never saved). */
      setQuality: (setting: QualitySetting) => void;
      /** M6 QA: the settings panel — open, whether the autopilot flies,
       * the stored values, and the live master/voice bus gains (null before
       * the audio context exists). */
      settings: () => {
        open: boolean;
        autopilot: boolean;
        values: Settings;
        gains: { master: number; voice: number } | null;
      };
      /** Claim the room's shared bot count (QA: 0 makes a scene reproducible). */
      setBots: (count: number) => void;
      net: () => {
        selfId: string;
        roomId: string;
        remotes: ReturnType<RemotePlanes["debug"]>;
        renderTime: number | null;
        /** O4: the world clock (renderTime unless `pinWorld` is set). */
        worldTime: number | null;
        /** The adaptive interpolation buffer this tab is holding, ms. */
        interpDelayMs: number;
        /** Measured snapshot-arrival jitter driving it, ms. */
        jitterMs: number;
        /** The hit-claim range budget the server will judge us against, m. */
        hitRangeBudget: number;
      };
      combat: () => {
        alive: boolean;
        hp: number;
        prot: boolean;
        heat: { heat: number; locked: boolean };
        scores: ScoreEntry[];
        lastDeath: {
          victimId: string;
          killerId: string | null;
          cause: DeathMsg["cause"];
        } | null;
        targets: { id: string; pos: { x: number; y: number; z: number } }[];
        hpBarTarget: string | null;
        /** P2 QA: bullets still in flight (each one a tracer draw). */
        bullets: number;
      };
      aimAt: (x: number, z: number, y?: number) => void;
      setFiring: (held: boolean) => void;
      /** H2 QA: every hole span (merged runs) and the decor mesh's counts,
       * plus the live assist bias — the gallery's hole views read these. */
      holes: () => {
        spans: {
          kind: string;
          axis: "x" | "z";
          center: Vec3;
          entry: Vec3;
          exit: Vec3;
          length: number;
          width: number;
          height: number;
          y0: number;
          hosts: number;
        }[];
        decor: { holes: number; quads: number; vertices: number };
        assist: { yaw: number; pitch: number };
      };
      freelook: () => ReturnType<typeof createFreeLook>;
      /** M1 QA: the aim point and whether the pipper sits on it (F1). */
      aim: () => {
        mode: "instructor" | "classic";
        converged: boolean;
        /** F6 QA: the pipper-to-cursor angle, rad. */
        gap: number;
        cursor: { x: number; y: number };
        ndc: { x: number; y: number };
      };
      /** M1 QA: the boost gauge (drained by BOOST, keyboard or touch). */
      boost: () => { energy: number; active: boolean };
      /** M1 QA: touch-control state; null off touch. */
      touch: () => ReturnType<TouchControls["debug"]> | null;
      /** U3 QA: the hint on screen, the queue left, the touch overlay. */
      coach: () => ReturnType<Coach["debug"]>;
      zoom: () => { held: boolean; z: number; fov: number };
      lampImage: (x: number, z: number) => { x: number; z: number } | null;
      traffic: (at?: number | null) => ReturnType<Traffic["debug"]>;
      /** L6 QA: the longest red-light queue at a server time (gallery pin). */
      trafficQueue: (at?: number) => ReturnType<Traffic["queue"]>;
      /** L6 QA: what intersection (bx, bz) shows at a server time. */
      trafficAspect: (
        bx: number,
        bz: number,
        at?: number,
      ) => ReturnType<Signals["sample"]>;
      movers: (at?: number | null) => ReturnType<Movers["debug"]>;
      train: (at?: number | null) => ReturnType<TrainRenderer["debug"]>;
      /** T2 QA: the next time two trains pass each other on a line. */
      trainMeeting: (
        line: number,
        fromMs?: number,
      ) => ReturnType<TrainRenderer["meeting"]>;
      fireworks: (at?: number | null) => ReturnType<Fireworks["debug"]>;
      windowClock: (sec: number | null) => void;
      /** L9 QA: flock centres at the render clock, and which are scattered. */
      birds: () => ReturnType<Birds["debug"]>;
      /** L10 QA: airliners and drone show drawn last frame, the news heli's
       * slot, and (forceDroneShow) the gallery's way to start a show now. */
      skyTraffic: () => {
        airliners: Airliners["drawn"];
        /** Each drawn airliner's offset from the viewer, m (y up). */
        airlinerOffsets: { x: number; y: number; z: number }[];
        airlinerPoints: number;
        droneShow: DroneShowRenderer["current"];
        newsHeli: typeof moverField.news;
      };
      forceDroneShow: (ageS: number | null) => void;
      cityStats: () => {
        buildings: number;
        tierInstances: number;
        clutterInstances: number;
        rooftopLife: RooftopLifeRenderer["counts"];
        garnishInstances: number;
        rigInstances: number;
        moverLights: number;
        beams: number;
        birds: number;
      };
      signage: () => Signage["counts"];
      jumbotron: () => Jumbotrons["stats"];
      jumbotronView: (i: number) => ReturnType<Jumbotrons["view"]>;
      signImage: (x: number, z: number) => { x: number; z: number } | null;
      /** L7: broken neon tubes and their next stutter burst (synced ms). */
      signBroken: (at?: number) => ReturnType<Signage["brokenTubes"]>;
      /**
       * L1 micro tier: the live gate, what each subsystem drew, and a sample
       * pinned to a FIXED block at a FIXED server time. The sample is pinned
       * rather than read in instance-slot order because the block window is
       * camera-relative — two tabs legitimately fill slots differently while
       * the city they draw is identical (the lesson __ab.traffic already
       * carries).
       */
      micro: (at?: number | null) => {
        gate: number;
        cameraY: number;
        on: boolean;
        drawn: {
          pedestrians: number;
          steamPuffs: number;
          signals: number;
          sparks: number;
        };
        meshesVisible: number;
        sample: {
          time: number;
          block: { bx: number; bz: number };
          peds: ReturnType<Pedestrians["sample"]>;
          signal: ReturnType<Signals["sample"]>;
          sites: number;
        };
      };
      /** Rendered truth: where pedestrian instance `i` was actually DRAWN,
       * read back out of the instance matrix — not a re-derivation. */
      microImage: (i: number) => { x: number; y: number; z: number } | null;
      /** Perf A/B: false takes the same early return as an above-gate camera,
       * so it skips the CPU work and not merely the draw call. */
      setMicro: (on: boolean) => void;
      /** G1 QA: what the street-detail rig drew, its keep shares, the paint. */
      streetDetail: () => StreetFurniture["counts"] & {
        sample: ReturnType<StreetFurniture["sample"]>;
      };
      /** G1 perf A/B: street furniture, parked cars and fine paint on/off. */
      setStreet: (on: boolean) => void;
      /** L8 perf A/B: hide/show the rooftop-life group (its 2 draw calls). */
      setRooftopLife: (on: boolean) => void;
      garnishImage: (x: number, z: number) => { x: number; z: number } | null;
      radio: () => {
        voiceOn: boolean;
        voiceReady: boolean;
        inCombat: boolean;
        log: { at: number; speaker: string; ticker: string; voice: string }[];
      };
      /** L4 QA: pin the weather to a synced time (number) or the middle of a
       * phase (name) in the current cycle; null releases the pin. */
      weather: (at?: number | WeatherPhase | null) => {
        shiftMs: number;
        timeMs: number | null;
        phase: string;
        phaseT: number;
        rain: number;
        wetness: number;
        haze: number;
        flash: number;
        drops: number;
      };
      /** L12 QA: force the sky cycle to a fraction (0..1) or a named
       * moment, or release it to the synced clock with null. */
      sky: (t?: number | "dusk" | "night" | "predawn" | null) => {
        phase: number;
        forced: boolean;
        clockPhase: number | null;
      };
      /** L2 QA: the city soundscape's per-layer gains and their inputs. */
      ambience: () => ReturnType<CityAmbience["debug"]>;
      /** A1 QA: what the city-life tier drew and holds. */
      cityLife: () => {
        drawn: number;
        statics: number;
        riders: number;
        taxis: { x: number; z: number; hazard: boolean }[];
        facade: FacadeLifeRenderer["counts"];
        facadeVisible: boolean;
        nearPasses: number;
        lookPasses: number;
        busker: number;
        near: ReturnType<CityLife["sampleNear"]>;
      };
      /** QA-only: hold the camera at a canonical eye looking at `at`
       * (null restores the chase camera). */
      qaCamera: (
        view: {
          eye: { x: number; y: number; z: number };
          at: { x: number; y: number; z: number };
        } | null,
      ) => void;
      /** QA-only: pin the reaction clock to a server time (null = live). */
      qaReactionClock: (serverTimeMs: number | null) => void;
      /**
       * O4 perf-harness pin: render the WORLD at this server time from now
       * on, advancing with the sim's step (null = the synced clock). Returns the
       * world time the next frame starts from.
       */
      pinWorld: (serverTimeMs: number | null) => number | null;
      /** L1 QA: the live city events and what the city is doing about them
       * at this tab's render clock — two tabs must report the same. */
      reactions: () => {
        renderTime: number | null;
        events: { kind: string; x: number; y: number; z: number; t: number }[];
        wakes: { x: number; z: number; strength: number }[];
        smokes: { x: number; base: number; z: number; age: number }[];
        responders: { kind: string; x: number; z: number; yaw: number }[];
        lowPasses: { x: number; z: number; t: number }[];
        puffs: number;
        smoke: CityReactor["smokeDebug"];
        camera: { x: number; y: number; z: number };
      };
      storm: () => {
        seed: number;
        strikes: { timeMs: number; x: number; z: number }[];
        nextStrike: { timeMs: number; x: number; z: number } | null;
        pings: { id: string; pos: { x: number; y: number; z: number } }[];
        selfReveal: number;
        fogFar: number;
        shake: { x: number; y: number; z: number };
      };
    };
  }
}
// --- M6 settings panel ---------------------------------------------------
// Portrait on a phone, or the gear / Esc anywhere: graphics, resolution,
// controls, sound — all applied live through the same seams G, M and the HUD
// toggles use. While it is open the touch controls are
// suspended, every held key and the trigger are dropped, and the autopilot
// (ui/settings.ts) flies the plane level and out of the skyline.
let settingsOpen = false;
/** The aim as the settings screen opened: what changed is toasted when it
 * closes (M9), since the screen covers the HUD while it is open. */
let aimAtOpen: { mode: AimMode; sensitivity: number | null } | null = null;
const settingsPanel = new SettingsPanel(
  {
    quality: () => ({ setting: qualitySetting, tier: qualityTier }),
    setQuality: (setting) => setQualitySetting(setting, true),
    fps: () => perf.fps,
    sensitivity: () => touchControls?.debug().sensitivity ?? null,
    setSensitivity: (value) => touchControls?.setSensitivity(value),
    aimMode: () => input.aimMode(),
    setAimMode: (mode) => input.setAimMode(mode),
    radioVoice: () => radioVoiceOn,
    haptics: () => (haptics.available ? haptics.enabled : null),
    setHaptics: (on) => haptics.setEnabled(on),
    autoFire: () => autoFireOn,
    setAutoFire: (on) => {
      autoFireOn = on;
    },
    setRadioVoice: (on) => {
      saveRadioVoice(on);
      paintRadioToggle(on);
    },
    setResScale: (scale) => {
      settings = { ...settings, resScale: scale };
      resLimits = limitsFor(qualityTier);
      if (resAuto) {
        // A fresh state at the new ceiling: the slider is the player
        // asking for exactly this many pixels, not a rung to re-earn.
        resolution = autoResolution(performance.now());
        applyPixelRatio(resolution.ratio);
      }
      resFrames.reset();
      cpuFrames.reset();
      interruptQuality();
    },
    setVolumes: (next) => {
      settings = { ...settings, ...next };
      applyVolumes();
    },
    onOpenChange: (open) => {
      settingsOpen = open;
      // Resuming recentres the touch aim onto the gun line (M7), so the
      // instructor picks up flying straight rather than from a stale point.
      touchControls?.setSuspended(open);
      const sensitivity = touchControls?.debug().sensitivity ?? null;
      if (!open) {
        if (aimAtOpen) {
          const mode = input.aimMode();
          hud.showAimChanges(
            mode !== aimAtOpen.mode ? mode : null,
            sensitivity !== aimAtOpen.sensitivity ? sensitivity : null,
            isTouch(),
          );
        }
        aimAtOpen = null;
        return;
      }
      aimAtOpen = { mode: input.aimMode(), sensitivity };
      input.releaseKeys();
      guns.setTrigger(false);
      guns.setAutoTrigger(false);
      boostKey.setHeld(false);
    },
  },
  settings,
  settingsStore,
);
window.__ab = {
  state: () => flight,
  teleport: (x, z, y = 300, yaw = 0) => {
    interruptQuality(); // O3: a transient
    flight = { ...createFlightState({ x, y, z }, yaw), speed: flight.speed };
    chase.snapTo(flight);
  },
  perf: () => ({
    fps: perf.fps,
    frameMs: perf.frameMs,
    drawCalls: renderer.info.render.calls,
    smokePuffs: smoke.puffCount,
  }),
  // P1 harness surface: percentiles over the window since the last reset.
  perfStats: () => frames.stats(),
  jsStats: () => jsFrames.stats(),
  perfSamples: () => frames.samples(),
  gpuStats: () => (gpuTimer === null ? null : gpuFrames.stats()),
  gpuSamples: () => (gpuTimer === null ? null : gpuFrames.samples()),
  gpuStarved: () => (gpuTimer === null ? null : gpuTimer.starved),
  perfReset: () => {
    frames.reset();
    jsFrames.reset();
    gpuFrames.reset();
    gpuTimer?.resetStarved();
  },
  render: () => {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      aa: renderOpts.aa,
      antialiasAttribute: renderer.getContextAttributes()?.antialias ?? false,
      defaultFramebufferSamples: DEFAULT_FB_SAMPLES,
      sceneTargetSamples: composer.renderTarget1.samples,
      pixelRatio: resolution.ratio,
      auto: resAuto,
      floor: resLimits.floor,
      ceiling: resLimits.ceiling,
      hotRatio: resolution.hotRatio,
      drawingBuffer: { width: size.x, height: size.y },
      // O4: which post chain, and the bloom chain's density divisor (the
      // fused chain runs it at CSS density) — for the harness's fill proxy.
      post: renderOpts.post,
      bloomDensity: bloomPass instanceof AbBloomPass ? bloomPass.cssDensity : 1,
    };
  },
  setPixelRatio: (ratio) => {
    if (ratio === "auto") {
      resAuto = true;
      resolution = autoResolution(performance.now());
    } else {
      resAuto = false;
      resolution = pinnedResolution(ratio);
    }
    applyPixelRatio(resolution.ratio);
    resFrames.reset();
    cpuFrames.reset();
  },
  quality: () => ({
    setting: qualitySetting,
    tier: qualityTier,
    auto: { ...autoQuality },
    ceiling: resLimits.ceiling,
    thermal: { ...thermal },
    bloom: bloomPass.enabled,
    grade: gradePass?.enabled ?? false,
    budgetMs: tierBudgetMs(qualityTier),
  }),
  setQuality: (setting) => setQualitySetting(setting, false),
  settings: () => ({
    open: settingsPanel.isOpen(),
    autopilot: settingsOpen && alive,
    values: settingsPanel.current(),
    gains: audio.busGains(),
  }),
  setBots: (count) => socket.sendSetBots(count),
  net: () => ({
    selfId: socket.selfId,
    roomId: currentRoomId,
    remotes: remotes.debug(),
    renderTime: socket.renderTime(),
    // O4: what the world renders at (= renderTime unless pinWorld is set).
    worldTime: worldTime(),
    // ANGE-4KO2W2 QA: the buffer, what it is reacting to, and the range
    // budget it buys — the three numbers that have to move together.
    interpDelayMs: socket.interpDelayMs,
    jitterMs: socket.jitterMs,
    hitRangeBudget: hitRangeBudgetFor(socket.interpDelayMs),
  }),
  combat: () => ({
    alive,
    hp: selfHp,
    prot: selfProt,
    heat: guns.state,
    scores: lastScores,
    lastDeath,
    targets: remotes.targets(),
    // Gun-feel QA: whose HP bar is showing right now (null = faded/none).
    hpBarTarget: hpBar.current(performance.now())?.targetId ?? null,
    bullets: bullets.all.length,
  }),
  // Point the nose at a canonical world position (torus-aware, QA only).
  aimAt: (x, z, y = flight.pos.y) => {
    const d = wrapDelta(flight.pos, { x, y, z });
    const flat = Math.hypot(d.x, d.z);
    flight = {
      ...flight,
      yaw: Math.atan2(-d.x, -d.z),
      pitch: Math.atan2(d.y, flat),
      roll: 0,
      rollRate: 0,
    };
    chase.snapTo(flight);
  },
  setFiring: (held) => guns.setTrigger(held),
  holes: () => ({
    spans: assistWorld.spans
      .filter((s) => s.hole.kind !== "bridge")
      .map((s) => ({
        kind: s.hole.kind,
        axis: s.hole.axis,
        center: s.center,
        entry: s.entry,
        exit: s.exit,
        length: s.length,
        width: s.hole.width,
        height: s.hole.height,
        y0: s.hole.y0,
        hosts: s.hosts.length,
      })),
    decor: holeDecor.counts,
    assist: { yaw: holeAssist.yaw, pitch: holeAssist.pitch },
  }),
  // B2 QA: current free-look state (drive it with real key/mouse events).
  freelook: () => freelook,
  aim: () => ({
    mode: aimMode,
    converged: aimConverged,
    gap: aimGap,
    cursor: input.cursorPx(),
    ndc: input.cursorNdc(),
  }),
  boost: () => ({ energy: boost.energy, active: boost.active }),
  touch: () => touchControls?.debug() ?? null,
  coach: () => coach.debug(),
  // ANGE-G9CPCV QA: aim-zoom state plus the FOV it is actually driving
  // (drive it with real button-2 mouse events).
  zoom: () => ({ held: zoom.held, z: zoom.z, fov: camera.fov }),
  // Seam QA: where the lamp nearest canonical (x, z) is drawn right now.
  lampImage: (x, z) => streetlights.imageOf(x, z),
  // Traffic QA: canonical poses of the first cars at a server time. Pass one
  // explicitly for the two-tab seam check — since ANGE-4KO2W2 each tab holds
  // its OWN interpolation delay, so two tabs' default render times are no
  // longer the same instant (that is the feature; the QA must pin the time).
  traffic: (at) => traffic.debug(at === undefined ? worldTime() : at),
  // L9 QA: flock centres and which are scattered, at the render clock.
  birds: () => birds.debug(worldTime()),
  // L6 QA: pin the gallery's red/green intersection views to a real queue.
  trafficQueue: (at) => traffic.queue(at ?? worldTime() ?? performance.now()),
  trafficAspect: (bx, bz, at) =>
    signals.sample(bx, bz, at ?? worldTime() ?? performance.now()),
  // L2 QA: jib angles, aircraft positions and the drawn read-back at a server
  // time. Pass the time explicitly for the two-tab check — each tab holds its
  // own interpolation delay, so their default render clocks are NOT the same
  // instant. Two tabs given the same `at` must return identical JSON.
  movers: (at) => movers.debug(at === undefined ? worldTime() : at),
  // L5 QA: the route, the cars' poses at a server time and the drawn read-back.
  train: (at) => train.debug(at === undefined ? worldTime() : at),
  trainMeeting: (line, fromMs) =>
    train.meeting(line, fromMs ?? worldTime() ?? 0),
  fireworks: (at) => fireworks.debug(at === undefined ? worldTime() : at),
  // L3 QA: pin the living-windows clock (live seconds) for t / t+60 s
  // captures; null follows the server clock again.
  windowClock: (sec) => city.pinLiveWindows(sec),
  skyTraffic: () => ({
    airliners: airliners.drawn,
    airlinerOffsets: airliners.drawn.map((a) => {
      const o = airlinerOffsetInto(a, worldTime() ?? 0, {
        x: 0,
        y: 0,
        z: 0,
        hx: 0,
        hz: 0,
      });
      return { x: o.x, y: o.y, z: o.z };
    }),
    airlinerPoints: airliners.pointCount,
    droneShow: droneShow.current,
    newsHeli: moverField.news,
  }),
  forceDroneShow: (ageS) =>
    droneShow.force(worldTime(), ageS === null ? null : ageS * 1000),
  // V2 QA: instance counts for the perf report.
  cityStats: () => ({
    buildings: city.cityBuildings.length,
    tierInstances: city.tierInstanceCount,
    clutterInstances: roofClutter.instanceCount,
    rooftopLife: rooftopLife.counts,
    garnishInstances: facadeGarnish.instanceCount,
    detailInstances: facadeDetail.instanceCount,
    rigInstances: movers.rigInstances,
    moverLights: moverLights.lightCount,
    beams: searchlights.beamCount,
    birds: birds.birdCount,
  }),
  // S2 QA: signage instance counts + drawn-position read-back (seam checks).
  signage: () => signage.counts,
  // S1 QA: what the jumbotrons say, the replay pass count/draws, and a
  // canonical view square on screen `i` (feed it to qaCamera).
  jumbotron: () => jumbotrons.stats,
  jumbotronView: (i) => jumbotrons.view(i),
  signImage: (x, z) => signage.imageOf(x, z),
  signBroken: (at) =>
    signage.brokenTubes(at ?? worldTime() ?? performance.now()),
  micro: (at) => {
    const time =
      at === undefined ? (worldTime() ?? performance.now()) : (at ?? 0);
    const gate = microOn ? microGate(chase.position.y) : 0;
    return {
      gate,
      cameraY: chase.position.y,
      on: microOn,
      drawn: {
        pedestrians: pedestrians.count,
        steamPuffs: steam.count,
        signals: signals.count,
        sparks: constructionSparks.count,
      },
      meshesVisible: [
        pedestrians.mesh.visible,
        steam.points.visible,
        signals.mesh.visible,
        constructionSparks.points.visible,
      ].filter(Boolean).length,
      sample: {
        time,
        block: MICRO_SAMPLE_BLOCK,
        peds: pedestrians.sample(
          MICRO_SAMPLE_BLOCK.bx,
          MICRO_SAMPLE_BLOCK.bz,
          time,
        ),
        signal: signals.sample(
          MICRO_SAMPLE_BLOCK.bx,
          MICRO_SAMPLE_BLOCK.bz,
          time,
        ),
        sites: constructionSparks.siteList.length,
      },
    };
  },
  microImage: (i) => pedestrians.imageOf(i),
  setMicro: (on) => {
    microOn = on;
  },
  streetDetail: () => ({
    ...streetFurniture.counts,
    sample: streetFurniture.sample(
      MICRO_SAMPLE_BLOCK.bx,
      MICRO_SAMPLE_BLOCK.bz,
    ),
  }),
  setStreet: (on) => streetFurniture.setEnabled(on),
  setRooftopLife: (on) => {
    rooftopLife.group.visible = on;
  },
  // ANGE-XY8LH8 seam QA: drawn position of the parapet nearest (x, z).
  garnishImage: (x, z) => facadeGarnish.imageOf(x, z),
  // Radio QA: recent on-air lines (headless runs can't hear the voice).
  radio: () => ({
    voiceOn: radioVoiceOn,
    voiceReady: radioVoice.ready,
    inCombat: radio.inCombat(performance.now()),
    log: radioLog.map((l) => ({ ...l })),
  }),
  ambience: () => ambience.debug(),
  cityLife: () => ({
    drawn: cityLife.count,
    statics: cityLife.staticDrawn,
    riders: cityLife.riders.riders.length,
    taxis: cityLife.taxiPoses.map((t) => ({
      x: t.x,
      z: t.z,
      hazard: t.hazard,
    })),
    facade: facadeLife.counts,
    facadeVisible: facadeLife.mesh.visible,
    nearPasses: reactor.nearPasses.length,
    lookPasses: lookPasses.uniforms.uAbPassCount.value,
    busker: busker.gain,
    near: cityLife.sampleNear(chase.position, 60),
  }),
  qaCamera: (view) => {
    qaView = view;
  },
  qaReactionClock: (serverTimeMs) => {
    qaReactAt = serverTimeMs;
  },
  pinWorld: (serverTimeMs) => {
    qaWorld =
      serverTimeMs === null ? null : { ms: serverTimeMs, frameMs: null };
    // A pin is a jump: the windowed feeds must not replay (or enumerate —
    // a jump of years is billions of buckets) everything in between.
    strikeFeed.reset();
    fireworks.resetClock();
    return worldTime();
  },
  reactions: () => {
    const r = reactor.reactions;
    return {
      renderTime: r.timeMs,
      events: reactor.eventList,
      wakes: r.wakes
        .slice(0, r.wakeCount)
        .map((w) => ({ x: w.x, z: w.z, strength: w.strength })),
      smokes: r.smokes
        .slice(0, r.smokeCount)
        .map((s) => ({ x: s.x, base: s.base, z: s.z, age: s.age })),
      responders: r.responders.slice(0, r.responderCount).map((v) => ({
        kind: v.kind,
        x: v.x,
        z: v.z,
        yaw: v.yaw,
      })),
      lowPasses: reactor.lowPasses.map((p) => ({ ...p })),
      puffs: reactor.puffCount,
      smoke: reactor.smokeDebug,
      camera: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
    };
  },
  sky: (t) => {
    if (t === null) skyCycle.forced = null;
    else if (typeof t === "string") skyCycle.forced = SKY_MOMENTS[t];
    else if (typeof t === "number") skyCycle.forced = t - Math.floor(t);
    const rt = worldTime();
    return {
      phase: skyCycle.phaseNow,
      forced: skyCycle.forced !== null,
      clockPhase: rt === null ? null : skyPhase(rt),
    };
  },
  // ST2 QA: consumed strikes (two tabs must agree), the next scheduled
  // strike (for staging reveals), live reveal pings, and atmosphere state.
  storm: () => {
    const rt = worldTime();
    return {
      seed: welcome.seed,
      strikes: strikeLog.map((s) => ({ ...s })),
      nextStrike:
        rt === null
          ? null
          : (strikesInWindow(welcome.seed, rt, rt + 40_000)[0] ?? null),
      pings: reveals.pings(performance.now()),
      selfReveal: reveals.levelOf(socket.selfId, performance.now()),
      fogFar: scene.fog instanceof THREE.Fog ? scene.fog.far : -1,
      shake: turbulenceOffset(performance.now(), flight.pos.y),
    };
  },
  weather: (at) => {
    const rt = worldTime();
    if (at === null) weatherShift = 0;
    else if (typeof at === "number") weatherShift = rt === null ? 0 : at - rt;
    else if (at !== undefined && rt !== null && WEATHER_PHASES.includes(at)) {
      const [a, b] = phaseWindow(welcome.seed, rt, at);
      weatherShift = (a + b) / 2 - rt;
    }
    const t = rt === null ? null : rt + weatherShift;
    const wx = weather.at(t);
    return {
      shiftMs: weatherShift,
      timeMs: t,
      phase: wx.phase,
      phaseT: wx.phaseT,
      rain: wx.rain,
      wetness: wx.wetness,
      haze: wx.haze,
      flash: wx.flash,
      drops: rain.drops,
    };
  },
};

// --- Frame loop ---
const poseEuler = new THREE.Euler();
const poseQuat = new THREE.Quaternion();
let last = performance.now();
// Pre-warm every program the scene can ever draw, behind the boot fade (O2):
// the micro tier (first seen descending through 140 m), and every effect
// that starts hidden — guns, explosions, sparks, storm bolts, searchlights,
// birds, movers, traffic, the prop blur, the HP sprite, name tags. Each would
// otherwise compile on the frame it first appears, which is exactly the
// moment a hitch is noticed. Each subsystem's update() then owns visibility.
fadeEl.classList.add("dead");
socket.sendPing(); // W1: the rest of the boot was built synchronously
await prewarmScene(renderer, scene, camera, composer);
socket.sendPing();
flashFade();

// Named (M2) so the visibility pause at the bottom can stop and restore it.
const frame = (now: number): void => {
  // O3: when this callback actually started running — the pre-render JS
  // cost below is measured from here (the rAF timestamp can predate it).
  const frameStart = performance.now();
  const rawMs = now - last;
  const dt = Math.min(rawMs / 1000, 0.05); // clamp hitches, keep sim stable
  last = now;

  // Drain look deltas every frame (dead too) so stale mouse motion never
  // dumps into the orbit as one jump. Signs: mouse-right pans the view
  // right, mouse-up looks up (both hand-tuned with LOOK_SENSITIVITY).
  const lookDelta = input.takeLookDelta();
  // Latch the render clock ONCE, on this frame's rAF timestamp: every system
  // below poses against the same instant, so the movers are drawn exactly
  // where the crash check tested them — dying to a jib drawn somewhere else
  // is the failure the shared seam exists to prevent. The clock is smoothed
  // (O2: net/clock.ts) — it never steps or runs backward when the delay
  // controller or the clock-offset estimate jumps. Null until the first
  // snapshot: movers then render hidden AND count as non-solid.
  const frameClock = socket.tickRenderClock(now);
  if (qaWorld !== null) {
    // O4 QA pin: advanced by the SIM's step (dt, clamped like the flight
    // model), not wall time, so the world and the plane move in lockstep —
    // frame n of a pass shows the same scene on a 3 fps software rasteriser
    // as on a GPU (where dt is never clamped and this IS real time).
    if (qaWorld.frameMs !== null) qaWorld.ms += dt * 1000;
    qaWorld.frameMs = now;
  }
  const renderMs = qaWorld !== null ? qaWorld.ms : frameClock.time;
  planeLights.begin(); // own + remote lights re-append every frame
  moverLights.begin(); // crane/aircraft lights + firework sparks, same deal
  // Cursor smoothing + the leave-the-window fade run alive or dead, so
  // neither comes back stale at respawn.
  // M1: the throttle slider servoes through input.read()'s throttle axis.
  touchControls?.frame(flight.targetSpeed, alive, dt);
  input.tick(dt);
  if (input.aimMode() !== aimMode) {
    // M flips the mode (dead or alive); a fresh instructor means no lagged
    // command from the other mode ever reaches the plane.
    aimMode = input.aimMode();
    instructor = createInstructor();
    // Changed on the settings screen: toasted when it closes.
    if (!settingsOpen) hud.showAimMode(aimMode, isTouch());
  }
  // Step the zoom OUTSIDE the alive gate: chase.update() only runs while
  // alive, so a death mid-zoom would otherwise freeze the FOV narrowed for
  // the whole kill-cam. Dying eases it back out instead.
  const zoomPrev = zoom.z;
  zoom = stepZoom(zoom, alive && zoomHeld(input.aimHeld(), freelook.held), dt);
  aimConverged = false;
  // Boost (F2): a burn starts only on a fresh press (drained every frame, dead
  // too, so a press during the kill-cam can't fire after respawn) and ends on
  // release or an empty gauge — each edge reaches the server's mirror.
  const boostPressed = boostKey.takePress();
  boost = boostLevel(boost, now);
  if (alive) {
    if (boostPressed && boostKey.isHeld()) setBoostBurning(true, now);
    else if (!boostKey.isHeld()) setBoostBurning(false, now);
  }
  if (boost.active !== boostSent) setBoostBurning(false, now); // ran dry
  if (alive) {
    freelook = stepFreeLook(
      freelook,
      input.freeLookHeld(),
      -lookDelta.dx,
      lookDelta.dy,
      dt,
    );
    hud.setFreeLook(freelook.held);
    hud.setZoom(zoom.z > 0);
    // Zoom buys its steady sight picture with turn rate, and spends it
    // through the same input-shaping seam free-look uses — the camera never
    // reaches flight state. Authority is the product of both costs.
    const steer = freelook.steer * zoomSteer(zoom.z);
    let command = input.read();
    // H2 hole assist: stands down while the pilot shoots, free-looks or the
    // view is reframing (zoom easing) — then glides back to zero.
    const assistOff =
      guns.firing ||
      freelook.held ||
      freelook.yaw !== 0 ||
      freelook.pitch !== 0 ||
      (zoom.z > 0 && zoom.z < 1);
    // Classic mode means to fly along the nose; the instructor sets the aim
    // ray's direction below.
    // (flightForward's formula, written in place: no per-frame allocation.)
    const cosP = Math.cos(flight.pitch);
    assistDir.x = -Math.sin(flight.yaw) * cosP;
    assistDir.y = Math.sin(flight.pitch);
    assistDir.z = -Math.cos(flight.yaw) * cosP;
    /** The pilot's own turn command, assist excluded — the corner manager's
     * intent, so the nudge can never make it brake for a turn. */
    let intentTurn = 0;
    if (settingsOpen) {
      // M6: the settings panel is up — the autopilot flies (wings level,
      // out of the skyline, throttle full). A fresh instructor every frame,
      // so closing the panel hands back with no lagged command.
      stepAssist(true, dt);
      command = autopilotInput(flight.pitch, flight.pos.y);
      instructor = createInstructor();
    } else if (aimMode === "instructor") {
      // The cursor is the aim point: fly the pipper onto it. The view is the
      // un-orbited chase frame at THIS frame's (already stepped) zoom, with
      // the same FOV formula the render writes (boost kick included) —
      // camera.fov itself is never read or written here.
      const aimFov = viewFov(zoom.z, overspeedOf(flight.speed), flight.speed);
      const aimFrame = chase.aimFrame(flight, zoom.z);
      // M7: a touch aim is a direction anchored in the world — project it
      // through this very view, so the cursor read just below IS it.
      const anchored =
        touchControls?.steer(flight, aimFrame, aimFov, camera.aspect, dt) ??
        false;
      const cursor = input.cursorNdc();
      const view = aimView(flight, aimFrame, aimFov, camera.aspect, cursor);
      // H2: where the pilot means to go — from the PLANE to the world point
      // the cursor marks ASSIST_AIM_RANGE out (the chase eye sits ~10° off
      // the gun line, so the eye ray's own angle would read misaligned).
      const aimLen = Math.hypot(view.aimDir.x, view.aimDir.y, view.aimDir.z);
      const k = ASSIST_AIM_RANGE / (aimLen || 1);
      const ax = aimFrame.eye.x + view.aimDir.x * k;
      const ay = aimFrame.eye.y + view.aimDir.y * k;
      const az = aimFrame.eye.z + view.aimDir.z * k;
      const an = Math.hypot(ax, ay, az) || 1;
      assistDir.x = ax / an;
      assistDir.y = ay / an;
      assistDir.z = az / an;
      const err = aimError(flight, view.aimDir, view.pipperDir);
      // Latch only what the VIEW changed this frame — the zoom easing, the
      // boost FOV kick, or the cursor moving while free-look owns the mouse
      // (held, or its orbit still easing back, which also covers the
      // smoothing catching up on the drag) — by re-reading the error with
      // last frame's zoom/FOV/cursor at the same attitude. The plane's own
      // turn is never latched, so a zoom pressed mid-turn keeps the turn.
      // An anchored touch aim latches nothing: it stays put in the world
      // when the view reframes (and aimFrame never sees the free-look orbit),
      // so its error is already free of any view change.
      let latch: AimError = { yaw: 0, pitch: 0 };
      const zoomMoved = zoom.z !== zoomPrev;
      const looking =
        freelook.held || freelook.yaw !== 0 || freelook.pitch !== 0;
      if (!anchored && (zoomMoved || aimFov !== aimFovPrev || looking)) {
        const z0 = zoomMoved ? zoomPrev : zoom.z;
        const before = aimView(
          flight,
          chase.aimFrame(flight, z0),
          aimFovPrev,
          camera.aspect,
          looking ? cursorPrev : cursor,
        );
        const e0 = aimError(flight, before.aimDir, before.pipperDir);
        latch = { yaw: err.yaw - e0.yaw, pitch: err.pitch - e0.pitch };
      }
      const reframing = looking || (zoom.z > 0 && zoom.z < 1);
      const rates = handlingRates(flight.speed, boost.active);
      stepAssist(assistOff, dt);
      // The assist biases the instructor's error toward the centreline (+yaw
      // is a right turn, i.e. less of the leftward error) — a stick nudge
      // would just be flown back out by the instructor's own loop.
      const assisting = holeAssist.yaw !== 0 || holeAssist.pitch !== 0;
      const unbiased = assisting
        ? instructorInput(err, latch, reframing, dt, instructor, rates)
        : null;
      instructor = instructorInput(
        assisting
          ? {
              yaw: err.yaw - holeAssist.yaw,
              pitch: err.pitch + holeAssist.pitch,
            }
          : err,
        latch,
        reframing,
        dt,
        instructor,
        rates,
      );
      intentTurn = (unbiased ?? instructor).turn * input.presence();
      // Off-window the presence fades the instructor out too: attitude hold.
      const presence = input.presence();
      command = {
        ...command,
        turn: instructor.turn * presence,
        pitch: instructor.pitch * presence,
      };
      // The reticle reads the unbiased view: the assist never shows.
      aimGap = angleBetween(view.aimDir, view.pipperDir);
      aimConverged = aimGap < CONVERGED_RAD;
      aimFovPrev = aimFov;
    } else {
      stepAssist(assistOff, dt);
      intentTurn = command.turn;
      if (holeAssist.yaw !== 0 || holeAssist.pitch !== 0) {
        assistStick(
          holeAssist,
          command,
          handlingRates(flight.speed, boost.active),
          assistStickOut,
        );
        command = {
          ...command,
          turn: assistStickOut.turn,
          pitch: assistStickOut.pitch,
        };
      }
    }
    // F5 corner speed manager: silently cap the commanded speed so the
    // turn the pilot is committing to (or the wall ahead) is makeable. Intent
    // is the turn command before free-look/zoom shaping; the clock is the one
    // the movers are drawn (and crash-checked) at.
    cornerCap = stepCornerCap(
      cornerCap,
      cornerSpeed(flight, cornerWorld, intentTurn, renderMs),
      dt,
    );
    const shaped = {
      ...shapeInput(command, { steer }),
      boost: boost.active,
      cornerCap: cornerCapInput(cornerCap),
    };
    leadYawRate =
      -shaped.turn * handlingRates(flight.speed, boost.active).turnRate;
    flight = stepFlight(flight, shaped, dt);
    // Own control surfaces follow what the stick is commanding (F3).
    ownControls = inputControls(shaped, flight);
    // Hold the post-boost tail to the wall-clock envelope the server checks
    // (boostSpeedCap): a slow or hidden frame clamps dt, so the sim's own
    // decay can lag the clock — this keeps every pose inside the mirror.
    const speedCap = boostSpeedCap(boost, now);
    if (flight.speed > speedCap) flight = { ...flight, speed: speedCap };
    if (
      detectCrash(
        flight,
        city.cityBuildings,
        city.cityIndex,
        moverField,
        renderMs,
        natureIndex,
      )
    ) {
      // Report and freeze; the server decides credit and the respawn.
      socket.sendCrash();
      enterDeath(null, "crash");
    }
  }

  // M8 auto-fire, stepped dead or alive so a death drops it at once. It
  // never pulls under our own spawn protection (only FIRE may spend it), on
  // an overheat lock, or where the guns are blocked (free-look, settings).
  guns.setAutoTrigger(
    stepAutoFire(
      autoFire,
      {
        enabled: autoFireOn,
        flying: alive && !freelook.held && !settingsOpen,
        solution: leadSolution,
        locked: guns.locked,
        protectedSelf: selfProt,
      },
      now,
    ),
  );
  if (alive) {
    // Stream our pose up (fixed TICK_UP_HZ cadence inside the socket,
    // stamped with this frame's time — the pose is the one simulated for it).
    poseEuler.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
    poseQuat.setFromEuler(poseEuler);
    if (awaitingReturn !== null && now - awaitingReturn > RETURN_HOLD_MAX_MS) {
      awaitingReturn = null;
    }
    if (awaitingReturn === null) {
      socket.sendPose(
        {
          pos: flight.pos,
          quat: { x: poseQuat.x, y: poseQuat.y, z: poseQuat.z, w: poseQuat.w },
          speed: flight.speed,
        },
        now,
      );
    }

    // Guns: at most one shot a frame; the same seq goes to server and sim.
    // Free-look suppresses shots (heat keeps cooling, none builds).
    const shot = guns.update(now, flight, !freelook.held && !settingsOpen);
    if (shot) {
      bullets.spawn(shot.seq, shot.origin, shot.vel);
      socket.sendFire(shot.seq);
      tracers.flash(shot.origin, now);
      audio.gunshot();
      radio.noteCombat(now); // firing = combat radio discipline
    }

    // In-cloud turbulence (ST2): pure offsets applied to the DISPLAYED
    // camera and plane only — sendPose above already read flight.pos, and
    // the flight model never sees any of this. Different time phases keep
    // the camera and the airframe from moving in lockstep.
    const camShake = turbulenceOffset(now, flight.pos.y);
    const planeShake = turbulenceOffset(now + 537, flight.pos.y);
    chaseMoversMs = renderMs;
    chase.update(camera, flight, dt, freelook, camShake, zoom.z, leadYawRate);
    const planePos = nearestImage(chase.position, flight.pos);
    plane.position.set(
      planePos.x + planeShake.x * 0.5,
      planePos.y + planeShake.y * 0.5,
      planePos.z + planeShake.z * 0.5,
    );
    plane.rotation.set(flight.pitch, flight.yaw, flight.roll, "YXZ");
    // Prop speed tracks the commanded throttle (same factor as remotes').
    spinPropeller(plane, dt * Math.min(flight.targetSpeed, cornerCap) * 0.7);
    animatePlane(plane, ownControls, flight.speed, selfHp, dt);
    // Own aviation lights + wingtip trails (strobe on the synced clock so
    // every client sees this plane blink at the same instant).
    planeLights.place(
      socket.selfId,
      planePos,
      poseQuat,
      flight.speed,
      renderMs ?? now,
      boost.active ? 1 : 0, // own flame follows the real burn, not speed
    );
    planeTrails.emit(socket.selfId, flight.pos, poseQuat, now, dt);
  } else if (killCamTargetId !== null) {
    // Kill-cam beat: hold position, watch the killer if we can see them.
    const killerPose = remotes.poseOf(killCamTargetId);
    if (killerPose) {
      const aim = nearestImage(chase.position, killerPose.pos);
      camera.lookAt(aim.x, aim.y, aim.z);
    }
  }

  // Bullets: bend own rounds a hair toward in-cone targets (magnetism seam),
  // then fly and sweep the frame's segment over every living remote.
  const targets = remotes.targets();
  for (const bullet of bullets.all) {
    if (!bullet.cosmetic) {
      bullet.vel = magnetizeVelocity(bullet.pos, bullet.vel, targets, dt);
    }
  }
  bullets.step(dt);
  // Backwards, so a hit's bullets.remove() never skips the next bullet
  // (and no per-frame copy of the list — O4).
  const live = bullets.all;
  for (let i = live.length - 1; i >= 0; i--) {
    const bullet = live[i];
    if (bullet === undefined) continue;
    if (bullet.cosmetic) {
      // An enemy bullet shaving past this frame → panned near-miss whoosh.
      if (
        alive &&
        closestApproach(bullet.prev, bullet.pos, flight.pos) < NEAR_MISS_RADIUS
      ) {
        audio.whoosh(spatialize(flight.pos, flight.yaw, bullet.pos).pan, now);
        radio.noteCombat(now);
        say(nearMissCallout(name));
      }
      continue;
    }
    const target = bulletImpact(bullet.prev, bullet.pos, targets);
    if (!target) continue;
    bullets.remove(bullet);
    if (impactKind(target) === "shield") {
      // U1: the server rejects hits on a spawn-protected plane, so a round
      // that meets one glances off — no claim, no marker, no thunk.
      shieldSparks.burst(bullet.pos, now);
      audio.shieldPing(now);
      continue;
    }
    socket.sendHit(
      target.id,
      bullet.origin,
      bullet.seq,
      remotes.extraDelayOf(target.id),
    );
    // Instant shooter-side feedback (marker + thunk + sparks at the
    // impact point); the server's damage broadcast stays the
    // authoritative confirm (crosshair blip).
    hud.hitMarker(now);
    haptics.hit(now);
    audio.hitThunk();
    sparks.burst(bullet.pos, now);
  }

  remotes.update(frameClock, chase.position, dt, now, (id) =>
    reveals.levelOf(id, now),
  );
  // Own rim-flash: the storm lit us up — same tint the remotes wear.
  const selfReveal = alive ? reveals.levelOf(socket.selfId, now) : 0;
  plane.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mat = child.material as THREE.MeshStandardMaterial;
      if (selfReveal > 0) {
        mat.emissive.setHex(REVEAL_COLOR);
        mat.emissiveIntensity = selfReveal * REVEAL_INTENSITY;
      } else if (mat.emissive.getHex() === REVEAL_COLOR) {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 1;
      }
    }
  });
  planeLights.commit();
  planeTrails.update(chase.position, now);

  // --- Radio: threat scan, ambient chatter, then the one-line channel ---
  if (alive && threatOnSix(flight.pos, flight.yaw, remotes.headings())) {
    say(threatCallout(name));
    radio.noteCombat(now); // an active tail counts as combat
  }
  const ambientLine = ambient.poll(now, botCallsigns());
  if (ambientLine) say(ambientLine);
  const onAir = radio.poll(now);
  if (onAir) {
    comms.add(onAir.speaker, onAir.ticker);
    radioLog.push({
      at: now,
      speaker: onAir.speaker,
      ticker: onAir.ticker,
      voice: onAir.voice,
    });
    if (radioLog.length > 20) radioLog.shift();
    // Muted voice: nothing plays — the ticker alone carries the line and
    // the queue's estimated duration paces the channel.
    if (radioVoiceOn) {
      radioVoice.speak(onAir.voice, onAir.speaker, () =>
        radio.release(performance.now()),
      );
    }
  }

  city.update(chase.position);
  // L3 living windows: slow on/off, TV glow, silhouettes and the cleaning
  // crew all run off this one shared-clock uniform (living-windows.ts).
  city.updateLiveWindows(renderMs, now);
  // Beacons pulse on server-synced time so every client is in phase.
  roofClutter.update(chase.position, renderMs ?? now);
  // L8: rooftop life animates on the same synced clock (local before sync).
  rooftopLife.update(renderMs ?? now);
  facadeGarnish.update(chase.position);
  facadeDetail.update(chase.position, microOn); // L13: re-streams on block change only
  streetlights.update(chase.position);
  // L9: crowns sway in the shared wind on the same latched clock.
  natureRenderer.update(chase.position, renderMs);
  fountains.update(chase.position, renderMs);
  // Neon pulses on the same synced clock as the beacons.
  signage.update(chase.position, renderMs ?? now);
  // S1: the screens, their ticker crawl, and — only on the frame after a
  // kill — the LAST KILL pass (it renders before the main pass below).
  jumbotrons.update(chase.position, renderMs);
  // L7: the nearest broken neon tube buzzes, crackling through its stutter;
  // silent while dead or with the tab hidden.
  const neonBuzz = signage.buzz(flight.pos, renderMs ?? now);
  audio.setNeonBuzz(
    alive && !document.hidden ? neonBuzz.gain : 0,
    spatialize(flight.pos, flight.yaw, neonBuzz.pos).pan,
  );
  // L1 reactive city: evaluate once on the latched clock, then hand the view
  // to traffic (responders + hazards), signals, pedestrians, searchlights.
  const cityReact = reactor.update(chase.position, qaReactAt ?? renderMs);
  // A1: the passes the crowds look up at (and pigeons flutter from), fed to
  // every figure shader once a frame; then the pickup taxis Traffic draws.
  lookPasses.update(chase.position, reactor.nearPasses, renderMs);
  cityLife.updateTaxis(renderMs);
  traffic.update(chase.position, renderMs, cityReact, cityLife.taxiPoses);
  headlights.update(chase.position, traffic); // L6: after traffic.update
  // Every L2 system takes the SAME latched clock the crash check used.
  movers.update(chase.position, renderMs, moverLights);
  // L5/T2, same latched clock; any plane passing close draws a horn.
  hornPlanes.length = 0;
  if (alive) hornPlanes.push(flight.pos);
  for (const target of targets) hornPlanes.push(target.pos);
  train.update(chase.position, renderMs, moverLights, hornPlanes);
  fireworks.update(chase.position, renderMs, moverLights);
  // After movers.update: the helicopters' belly spots are this frame's, and
  // the lamp heads land in the same point cloud before commit().
  trackedPlanes.length = 0;
  const selfOnRecord = renderMs === null ? null : reactor.selfAt(renderMs);
  if (selfOnRecord) trackedPlanes.push(selfOnRecord);
  for (const target of targets) trackedPlanes.push(target.pos);
  // S1: the landmark lamp follows the TOP PILOT's drawn plane (none while
  // the leader is dead — targets() lists the living only).
  let leaderPos: Vec3 | null = null;
  if (leaderId === socket.selfId) leaderPos = alive ? flight.pos : null;
  else {
    for (const target of targets) {
      if (target.id === leaderId) leaderPos = target.pos;
    }
  }
  searchlights.update(
    chase.position,
    renderMs,
    movers.spots,
    moverLights,
    trackedPlanes,
    leaderPos,
  );
  // L9: flocks scatter from any plane this client sees within ~60 m.
  birdPlanes.length = 0;
  if (alive) birdPlanes.push(flight.pos);
  for (const r of remotes.headings()) birdPlanes.push(r.pos);
  birds.update(chase.position, renderMs, birdPlanes);
  // L10: the drones write LAST, so a full cloud drops drones, not nav lights.
  droneShow.update(chase.position, renderMs, moverLights);
  moverLights.commit();
  // L1 micro tier — on the same latched clock, for the same reason. ONE gate
  // value drives all four subsystems; k === 0 takes an early return inside
  // each, so above 140 m (and with ?micro=0) they cost no draw call AND no
  // per-instance CPU work.
  //
  // Kill-cam note: chase.update() only runs while alive, so during the death
  // beat the gate reads a frozen camera altitude. That is correct — the view
  // is frozen too.
  const microK = microOn ? microGate(chase.position.y) : 0;
  pedestrians.update(
    chase.position,
    renderMs,
    microK,
    reactor.lowPasses,
    reactor.nearPasses,
  );
  // A1 city life: statics stream on block change, movers every frame.
  cityLife.update(
    chase.position,
    renderMs,
    microK,
    reactor.nearPasses,
    microOn,
  );
  facadeLife.update(renderMs ?? now, microOn);
  holeDecor.update(renderMs ?? now); // H2: fans and chevron sweep
  // Phase-only subsystems fall back to local time before the first snapshot
  // (the signage policy): a plume or a signal in the wrong part of its cycle
  // is invisible, where hiding every one of them until clock sync would not be.
  steam.update(chase.position, renderMs ?? now, microK);
  // G1: static layout — re-packed only when the block window moves; the
  // furniture thins with the micro gate, parked cars by their own gate.
  streetFurniture.update(chase.position, microK);
  signals.update(chase.position, renderMs ?? now, microK, cityReact);
  constructionSparks.update(chase.position, renderMs ?? now, microK);
  ground.update(chase.position);
  river.update(chase.position, renderMs, now); // L11
  skyDome.update(chase.position);
  airliners.update(renderMs);
  // Wounded smoke: own plane from server-said self HP, every remote (human
  // or bot) from snapshot HP — all clients see the same wounds. Death clouds
  // simply stop being synced and age out inside SmokeTrails.
  if (alive) {
    smoke.sync(socket.selfId, flight.pos, now, smokeActive(selfHp));
  }
  for (const target of targets) {
    smoke.sync(target.id, target.pos, now, smokeActive(target.hp));
  }
  smoke.update(chase.position, now);
  // Storm: consume this frame's scheduled strikes, then age/place the bolts
  // and drive the sky-flash pulse (fog stain + dome tint + violet ambient).
  for (const s of strikeFeed.poll(renderMs)) {
    storm.strike(s, now);
    strikeLog.push({ timeMs: s.timeMs, x: s.x, z: s.z });
    if (strikeLog.length > 12) strikeLog.shift();
    // Everyone in the strike's column is revealed — self included; remote
    // positions come from the same interpolated poses everything else uses.
    const planesNow = [
      ...(alive ? [{ id: socket.selfId, pos: flight.pos }] : []),
      ...remotes.targets(),
    ];
    reveals.onStrike(s, planesNow, now);
    thunder.add(s, flight.pos, now);
  }
  for (const ev of thunder.due(now)) audio.thunder(ev.gain, ev.hard);
  storm.update(chase.position, now);
  clouds.update(chase.position, camera.quaternion, renderMs);
  // L12: the cycle's horizon is the storm's clear-sky fog base.
  skyCycle.update(renderMs);
  storm.setFogBase(skyCycle.horizon);
  // L4 weather on the latched clock: rain streaks, wet surfaces, and
  // (through atmosphere, the single fog writer) haze + flash strength. The
  // rain bed rides L2's ambience below (rain.level).
  const wxMs = renderMs === null ? null : renderMs + weatherShift;
  const wx = weather.at(wxMs);
  setWeatherUniform(wx, wxMs);
  jumbotrons.setWarning(wxMs === null ? null : stormWarning(wx)); // S1 banner
  rain.update(wx, wxMs, camera.position, dt);
  const sky = storm.atmosphere(scene, chase.position.y, now, wx);
  skyDome.tint(sky.tint);
  skyDome.mesh.visible = sky.domeVisible;
  explosions.update(chase.position, now, dt);
  sparks.update(chase.position, now);
  shieldSparks.update(chase.position, now);
  tracers.update(bullets.all, chase.position, now);

  // Target HP bar: over the plane WE damaged in the last 3 s (fading).
  const shownBar = hpBar.current(now);
  const barTarget = shownBar
    ? targets.find((t) => t.id === shownBar.targetId)
    : undefined;
  if (shownBar && barTarget) {
    const p = nearestImage(chase.position, barTarget.pos);
    hpBarSprite.sprite.position.set(p.x, p.y + HPBAR_ALTITUDE, p.z);
    // Snapshot HP is fresher than the damage event (covers regen ticks).
    hpBarSprite.show(barTarget.hp, shownBar.alpha);
  } else {
    hpBarSprite.hide();
  }

  const heat = guns.state;
  hud.setHeat(heat.heat, heat.locked);
  hud.setBoost(boost.energy, boost.active);
  hud.update(now);
  // The camera's real heading (free-look included) — the arcs are screen-
  // relative, so they follow where the player is LOOKING, not the nose.
  camera.getWorldDirection(viewDir);
  damageIndicator.update(
    now,
    flight.pos,
    Math.atan2(-viewDir.x, -viewDir.z),
    shooterLivePos,
  );
  const contacts = remotes.contacts();
  minimap.update(flight.pos, flight.yaw, contacts, reveals.pings(now));
  // 0 at ≤ MAX_SPEED, 1 at full boost speed: drives the engine pitch rise and
  // the FOV kick, and eases out with the post-boost tail on its own.
  const overspeed = alive ? overspeedOf(flight.speed) : 0;
  // The engine note follows the EFFECTIVE command — throttle under the F5
  // corner cap — the manager's only cue, and an audio one.
  audio.setEngine(Math.min(flight.targetSpeed, cornerCap), alive, overspeed);
  audio.syncRemotes(contacts, flight.pos, flight.yaw);
  // In-cloud static bed: quiet crackle ramping in over the deck's first
  // 60 m. The only audio cue for the hidden ceiling — no HUD, by design.
  audio.setStatic(
    alive ? Math.min(1, Math.max(0, (flight.pos.y - CLOUD_BASE) / 60)) : 0,
  );
  // L2 city soundscape, heard from the plane (the echo follows it into a
  // hole); sirens run on the synced clock, so every client hears the same.
  ambience.update({
    pos: flight.pos,
    yaw: flight.yaw,
    speed: alive ? flight.speed : 0,
    alive,
    combat: radio.inCombat(now),
    serverTimeMs: renderMs,
    rain: rain.level, // L4 weather
  });
  // A1: the nearest busker within earshot of the plane (silent if none).
  busker.update(
    flight.pos,
    flight.yaw,
    alive && cityLife.nearestPerformer(flight.pos, buskerAt) < 120
      ? buskerAt
      : null,
  );
  // L5/T2: the rumble from the nearest car (quieter standing at a station),
  // squealing on a curve, clattering over the joints, and the horn.
  audio.setTrainRumble(
    train.sound.at,
    train.sound.squeal,
    flight.pos,
    flight.yaw,
    train.sound.speed01,
  );
  trainAudio.update({
    listener: flight.pos,
    yaw: flight.yaw,
    at: train.sound.at,
    speed: train.sound.speed,
    horn: train.sound.horn,
    alive,
  });

  // FOV must land BEFORE the render: the lead reticle and edge markers below
  // read camera.projectionMatrix directly, so writing it after would project
  // them with last frame's FOV. Guarded so a static FOV costs nothing, and
  // aspect (the resize handler's business) is left alone.
  const fov = viewFov(zoom.z, overspeed, alive ? flight.speed : MIN_SPEED);
  if (camera.fov !== fov) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  if (qaView) {
    const eye = nearestImage(chase.position, qaView.eye);
    const at = nearestImage(eye, qaView.at);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.lookAt(at.x, at.y, at.z);
  }
  // Everything up to here is this frame's JS: sim, streaming, instance
  // packing. The render call is NOT included — a driver can block in it
  // waiting on the GPU, which would read a GPU-bound frame as CPU-bound.
  const preRenderMs = performance.now() - frameStart;
  renderer.info.reset();
  gpuTimer?.begin();
  composer.render();
  gpuTimer?.end();

  // Matrices are fresh after the render — project the screen-space UI now.
  edgeMarkers.update(
    camera,
    chase.position,
    targets.map((t) => t.pos),
    markerScratch,
  );
  const aimResult = leadIndicator.update(
    camera,
    chase.position,
    flight,
    alive ? targets : [], // no reticle from the kill-cam
    markerScratch,
  );
  // The pipper is the gun line's own vanishing point, so it only means
  // anything while we are flying it — the kill-cam gets no aim chrome.
  hud.setAimPoint(alive ? aimResult.aim : null);
  leadSolution = alive && aimResult.solution;
  touchControls?.setLeadReticle(alive ? aimResult.lead : null);
  // The instructor's cursor marker: only while flying in that mode (the
  // kill-cam and classic mode keep the plain OS cursor).
  hud.setAimCursor(
    alive && aimMode === "instructor" ? input.cursorPx() : null,
    aimConverged,
  );
  const cursorNow = input.cursorNdc();
  // U3: the first-life hints watch for each control being used — by hand:
  // auto-fire's trigger is not the player firing.
  const flying = alive && !settingsOpen;
  if (flying && !isTouch()) {
    coach.noteCursor(
      cursorNow.x - cursorPrev.x,
      cursorNow.y - cursorPrev.y,
      camera.fov,
      camera.aspect,
    );
  }
  if (flying && guns.triggerHeld) coach.note("fire");
  if (flying && boost.active) coach.note("boost");
  if (flying && scoreboard.isOpen) coach.note("scores");
  coach.frame(Math.min(rawMs, 250), alive, settingsOpen || document.hidden);
  cursorPrev = cursorNow;
  if (solutionTone.shouldPlay(alive && aimResult.solution, now)) {
    audio.solutionTick();
  }

  // --- Perf accounting (P1) ---
  // Both meters take the RAW frame delta, not the clamped sim dt: a 200 ms
  // hitch is exactly the number this ticket exists to surface, and the sim
  // clamp is there to keep flight stable, not to flatter the report.
  const drawCalls = renderer.info.render.calls;
  frames.push(rawMs, drawCalls);
  jsFrames.push(preRenderMs, drawCalls);
  resFrames.push(rawMs, drawCalls);
  cpuFrames.push(preRenderMs, drawCalls);
  // GPU results land a few frames late — they are attributed to the window,
  // not to a specific frame, which is all the percentiles need.
  if (gpuTimer !== null) {
    for (const ms of gpuTimer.drain()) gpuFrames.push(ms, drawCalls);
  }
  if (resWarmupUntil < 0) resWarmupUntil = now + RES_WARMUP_MS;
  if (now < resWarmupUntil) {
    // Keep the window empty rather than merely ignoring it, so the first
    // decision is taken on 45 frames that are ALL post-warm-up.
    resFrames.reset();
    cpuFrames.reset();
  } else if (now >= nextResEvalAt) {
    nextResEvalAt = now + RES_EVAL_MS;
    // Auto FIRST, on the same window: a scaler step empties the window, and
    // stepping first would hide every full window from Auto until the
    // scaler hit its floor — on a CPU-bound machine, four rungs of misses
    // that pixels could never fix.
    if (qualitySetting === "auto") stepQuality(now);
    if (resAuto) stepScaler(now);
  }
  perfHud.update(
    now,
    () => frames.stats(),
    { ratio: resolution.ratio, auto: resAuto },
    renderOpts.aa,
    () => (gpuTimer === null ? null : gpuFrames.stats()),
    () => gpuTimer?.starved ?? 0,
  );

  // HUD + rolling perf counters (~2 Hz refresh).
  perf.frames++;
  perf.ms += rawMs;
  if (perf.frames >= 30) {
    perf.frameMs = perf.ms / perf.frames;
    perf.fps = 1000 / perf.frameMs;
    perf.frames = 0;
    perf.ms = 0;
    const stats =
      `SPD ${flight.speed.toFixed(0)} m/s  THR ${flight.targetSpeed.toFixed(0)}  ` +
      `ALT ${flight.pos.y.toFixed(0)} m`;
    // Touch (M9): a short line for the top band — no player count or FPS.
    hudEl.textContent = isTouch()
      ? stats
      : `${stats}  PLR ${remotes.count + 1}  FPS ${perf.fps.toFixed(0)}`;
  }
};
renderer.setAnimationLoop(frame);
// W1: the loading card comes down with the first rendered frame — this rAF
// was queued after the loop's own, so it runs right after frame() has drawn.
// From here the pose stream is the keepalive.
requestAnimationFrame(() => {
  clearInterval(bootPing);
  closeJoin();
  coach.start(); // U3: hints and the touch coach marks greet the first spawn
});

// --- M2: backgrounded tab → pause; back with a dead session → rejoin ---
// Browsers already throttle rAF in a hidden tab; stop the loop outright so a
// phone app-switch burns nothing (GameAudio suspends itself on the same
// event). On return, a fresh `last` keeps the first dt from spanning the gap.
//
// W2: hidden also means AWAY — the server takes the plane out of the world
// (keeping its seat) instead of leaving it frozen as a free kill, and a 1 Hz
// heartbeat keeps the socket. Back, the server answers with a fresh spawn,
// which poses wait for: the local flight state froze with the tab.
let glLost = false;
let hiddenPing: ReturnType<typeof setInterval> | undefined;
document.addEventListener("visibilitychange", () => {
  interruptQuality(); // O3: a transient
  if (document.hidden) {
    renderer.setAnimationLoop(null);
    // The server's boost mirror restarts idle on return: stop our burn now
    // so the next start edge is actually sent.
    setBoostBurning(false, performance.now());
    socket.sendAway(true);
    clearInterval(hiddenPing);
    hiddenPing = setInterval(() => socket.sendPing(), AWAY_PING_INTERVAL_MS);
  } else {
    clearInterval(hiddenPing);
    socket.sendAway(false);
    if (awayStarted) awaitingReturn = performance.now();
    if (!glLost) {
      last = performance.now();
      renderer.setAnimationLoop(frame);
    }
  }
});
// A session the socket couldn't resume (W2: refused, or the window ran out)
// is over; iOS also tends to drop the GL context. Neither recovers in place,
// so offer a one-tap rejoin — carrying the resume token, so a reload whose
// session the server still holds comes back as the same player. Never
// during an unload, and only once the tab is visible again (wired after the
// welcome, so a rejected join keeps its own showJoinError).
let unloading = false;
const signalLost = (): void => {
  if (unloading) return;
  if (document.hidden) {
    document.addEventListener("visibilitychange", signalLost, { once: true });
    return;
  }
  hud.setReconnecting(false);
  showSignalLost(socket.resumeToken);
};
window.addEventListener("pagehide", () => {
  unloading = true;
});
// Restored from the back/forward cache: the socket died while frozen and
// no close event reaches this page.
window.addEventListener("pageshow", (e) => {
  if (!e.persisted) return;
  unloading = false;
  signalLost();
});
socket.events.onClose = signalLost;
if (droppedDuringBoot) signalLost();
else if (resumedDuringBoot) applyResume(resumedDuringBoot);
renderer.domElement.addEventListener("webglcontextlost", () => {
  glLost = true;
  renderer.setAnimationLoop(null);
  signalLost();
});

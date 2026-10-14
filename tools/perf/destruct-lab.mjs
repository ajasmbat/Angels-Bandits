// DL1 Destruction Lab evidence: drive the real lab (`?destructlab`) in a
// headless browser — pick an arena, set a trigger off through the room's
// real pipeline, watch it on the lab's own clock — and save what it shows:
// the panel, a frame mid-collapse, and the lab's OWN time-lapse sheet (its
// "Time-lapse sheet" export, read back from __ab.destructLab().lastSheet),
// plus the lab's telemetry (fps, draws, pieces, the server's collapse tick).
//
//   npm run build -w client
//   node tools/perf/destruct-lab.mjs <outDir> [--device desktop|phone]
//     [--cases topple,pancake,shear,chain] [--preset <id>] [--port 8241]
//
// Same browser knobs as gallery.mjs (AB_CHROME / AB_CHROME_ARGS — e.g.
// SwiftShader on a GPU-less box). The city is quiet (AB_QUIET_CITY): the
// lab breaks what it is told to and nothing else.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = resolve(
  argv[0] && !argv[0].startsWith("--") ? argv[0] : "destruct-lab",
);
const PORT = Number(opt("port", 8241));
const DEVICE = opt("device", "desktop");
const PRESET = opt("preset", "");
/** A case: the trigger, the arena it runs in, its options. */
const CASES = {
  topple: { k: "topple", arena: 1, dir: 1 },
  supertall: { k: "topple", arena: 2, dir: 1 },
  pancake: { k: "pancake", arena: 0 },
  shear: { k: "shear", arena: 1, corner: 3 },
  charge: { k: "charge", arena: 0, floor: 2 },
  neighbour: { k: "neighbour", arena: 2 },
  chain: { k: "chain", arena: 0 },
  bomb: { k: "bomb", arena: 1 },
  missile: { k: "missile", arena: 1 },
  shoot: { k: "shoot", arena: 1 },
};
const ONLY = opt("cases", "topple,pancake,shear,chain").split(",");
const PROFILES = {
  desktop: {
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
  },
  // run.mjs's phone: a landscape iPhone 12-class screen, touch, mobile.
  phone: {
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  },
};

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    AB_WAVES: "0",
    AB_QUIET_CITY: "1",
    LIVENESS_TIMEOUT_MS: "600000",
  },
  stdio: "ignore",
});
let browser = null;
const stop = async () => {
  await browser?.close().catch(() => {});
  server.kill();
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => stop().finally(() => process.exit(130)));
}

const until = (page, fn, arg, timeout = 600_000) =>
  page.waitForFunction(fn, arg, { polling: 500, timeout });

try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  browser = await chromium.launch({
    ...(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {}),
    args: process.env.AB_CHROME_ARGS
      ? process.env.AB_CHROME_ARGS.split(" ").filter(Boolean)
      : [],
  });
  const page = await browser.newPage(PROFILES[DEVICE] ?? PROFILES.desktop);
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/?destructlab&res=1`);
  await page.fill("#join-name", "DLAB");
  await page.click('#join button[type="submit"]');
  await until(page, () => !!window.__ab?.destructLab?.());
  await until(page, () => window.__ab.renderMs() !== null);
  if (PRESET) {
    await page.evaluate((id) => {
      document.querySelector(`[data-preset="${id}"]`)?.click();
    }, PRESET);
  }
  await sleep(4000);
  await page.screenshot({
    path: `${OUT}/${DEVICE}-panel.png`,
    timeout: 300_000,
  });
  const stats = {};
  for (const name of ONLY) {
    const c = CASES[name];
    if (!c) continue;
    console.log(`case ${name}`);
    await page.evaluate(() => window.__ab.destructLab().resetArena());
    await until(page, () => window.__ab.destructLab().debug().collapses === 0);
    await page.evaluate((a) => {
      const l = window.__ab.destructLab();
      l.pickArena(a.arena);
      if (a.dir !== undefined) l.panel.options.dir = a.dir;
      if (a.corner !== undefined) l.panel.options.corner = a.corner;
      if (a.floor !== undefined) l.panel.options.floor = a.floor;
    }, c);
    await sleep(2500);
    await page.evaluate((k) => window.__ab.destructLab().fire(k), c.k);
    await until(page, () => window.__ab.destructLab().debug().focus !== null);
    const focus = await page.evaluate(
      () => window.__ab.destructLab().debug().focus,
    );
    // Mid-collapse, with the panel and the telemetry.
    await until(
      page,
      (t) => (window.__ab.renderMs() ?? 0) >= t,
      focus.t0 + 4500,
    );
    await page.screenshot({
      path: `${OUT}/${DEVICE}-${name}-mid.png`,
      timeout: 300_000,
    });
    stats[name] = await page.evaluate(() => ({
      ...window.__ab.destructLab().debug(),
      strip: document.querySelector(".dlab-telemetry")?.textContent ?? "",
    }));
    // The lab's own time-lapse sheet, once the collapse has played out.
    await until(
      page,
      (t) => (window.__ab.renderMs() ?? 0) >= t,
      focus.t0 + 15_000,
    );
    await page.evaluate(() => {
      const l = window.__ab.destructLab();
      l.lastSheet = null;
      l.timelapse();
    });
    await until(page, () => window.__ab.destructLab().lastSheet !== null);
    const sheet = await page.evaluate(
      () => window.__ab.destructLab().lastSheet,
    );
    writeFileSync(
      `${OUT}/${DEVICE}-${name}-timelapse.png`,
      Buffer.from(sheet.split(",")[1], "base64"),
    );
  }
  writeFileSync(`${OUT}/${DEVICE}-stats.json`, JSON.stringify(stats, null, 2));
  console.log(`wrote ${OUT}`);
} finally {
  await stop();
}

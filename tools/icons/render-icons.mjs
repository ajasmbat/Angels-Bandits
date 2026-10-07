// App icons (M2): rasterise client/public/icons/icon.svg into the PNGs the
// manifest and the apple-touch-icon link point at. Run by hand after editing
// the SVG — the PNGs are committed, nothing renders at build time:
//   node tools/icons/render-icons.mjs
// Playwright is already a devDependency (the perf harness), so this adds no
// dependency. AB_CHROME points it at a specific Chromium binary.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const DIR = resolve("client/public/icons");
const svg = readFileSync(resolve(DIR, "icon.svg"), "utf8");

/** file → edge px. The manifest lists icon-512 for both purposes: the plane
 * already sits inside the 80% safe circle a launcher mask may crop to. */
const OUTPUTS = {
  "icon-192.png": 192,
  "icon-512.png": 512,
  "apple-touch-icon.png": 180,
};

const browser = await chromium.launch(
  process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : {},
);
try {
  for (const [file, size] of Object.entries(OUTPUTS)) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    await page.screenshot({ path: resolve(DIR, file), omitBackground: false });
    await page.close();
    console.log(`${file} ${size}x${size}`);
  }
} finally {
  await browser.close();
}

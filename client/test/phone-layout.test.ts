// M9 phone layout that fits: on short landscape phone screens (Safari tabs,
// windowed Android, in-app browsers) the touch controls stay inside the
// screen and its safe areas, under the HUD's top band and clear of each
// other, and every touch target is at least 44 px. The layout is pure
// index.html CSS, so — as fullscreen-markup.test.ts does — this reads the
// stylesheet as text: a small cascade (selector specificity, source order,
// the media queries in it) and a calc()/var()/env()/min() evaluator that
// THROWS on anything it doesn't understand, so an unparsed value can never
// quietly read as NaN and pass a comparison.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = (() => {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) throw new Error("no <style> in index.html");
  return (m[1] as string).replace(/\/\*[\s\S]*?\*\//g, "");
})();

// --- A tiny stylesheet model ---------------------------------------------------

interface Rule {
  media: string | null;
  selectors: string[];
  decls: [string, string][];
  order: number;
}

/** Every style rule, in source order, with the @media it sits in. */
const rules: Rule[] = (() => {
  const out: Rule[] = [];
  let i = 0;
  const parse = (media: string | null, end: number): void => {
    while (i < end) {
      const open = css.indexOf("{", i);
      const close = css.indexOf("}", i);
      if (open < 0 || open > end || (close >= 0 && close < open)) {
        i = close < 0 ? end : close + 1;
        return;
      }
      const prelude = css.slice(i, open).trim();
      i = open + 1;
      if (prelude.startsWith("@")) {
        // A nested block: @media rules count, @keyframes frames never match.
        parse(prelude.startsWith("@media") ? prelude : "@other", end);
        continue;
      }
      const stop = css.indexOf("}", i);
      const body = css.slice(i, stop);
      i = stop + 1;
      out.push({
        media,
        selectors: prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
        decls: body
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const c = d.indexOf(":");
            return [d.slice(0, c).trim(), d.slice(c + 1).trim()];
          }),
        order: out.length,
      });
    }
  };
  parse(null, css.length);
  return out;
})();

interface Viewport {
  w: number;
  h: number;
  /** Safe-area insets: top, right, bottom, left. */
  safe: [number, number, number, number];
}

/** Does `media` (an @media prelude, or null) apply in `vp`? */
function mediaMatches(media: string | null, vp: Viewport): boolean {
  if (media === null) return true;
  if (media === "@other") return false;
  const q = media.replace(/^@media\s*/, "");
  let m = q.match(/^\((max|min)-(height|width):\s*(\d+)px\)$/);
  if (m) {
    const size = m[2] === "height" ? vp.h : vp.w;
    return m[1] === "max" ? size <= Number(m[3]) : size >= Number(m[3]);
  }
  m = q.match(/^\(orientation:\s*(portrait|landscape)\)$/);
  if (m) return vp.h >= vp.w === (m[1] === "portrait");
  m = q.match(/^\(min-aspect-ratio:\s*(\d+)\/(\d+)\)$/);
  if (m) return vp.w / vp.h >= Number(m[1]) / Number(m[2]);
  if (q === "(prefers-reduced-motion: reduce)") return false;
  throw new Error(`unknown media query: ${media}`);
}

/** [ids, classes/pseudo-classes, types/pseudo-elements] of one selector. */
function specificity(sel: string): [number, number, number] {
  const ids = (sel.match(/#[\w-]+/g) ?? []).length;
  const pseudoEls = (sel.match(/::[\w-]+/g) ?? []).length;
  const rest = sel.replace(/::[\w-]+/g, "");
  const classes =
    (rest.match(/\.[\w-]+/g) ?? []).length +
    (rest.match(/:(?!not\()[\w-]+/g) ?? []).length +
    (rest.match(/\[[^\]]*\]/g) ?? []).length;
  const types = (rest.match(/(^|[\s>+~])[a-z]+/g) ?? []).length + pseudoEls;
  return [ids, classes, types];
}

/** The cascaded declarations for an element that the given selectors match
 * (body.touch set, so every `body.touch …` variant is listed explicitly). */
function computed(
  vp: Viewport,
  matches: readonly string[],
): Map<string, string> {
  const hits: {
    spec: [number, number, number];
    order: number;
    decls: [string, string][];
  }[] = [];
  for (const r of rules) {
    for (const sel of r.selectors) {
      if (!matches.includes(sel)) continue;
      if (!mediaMatches(r.media, vp)) continue;
      hits.push({ spec: specificity(sel), order: r.order, decls: r.decls });
    }
  }
  hits.sort(
    (a, b) =>
      a.spec[0] - b.spec[0] ||
      a.spec[1] - b.spec[1] ||
      a.spec[2] - b.spec[2] ||
      a.order - b.order,
  );
  const out = new Map<string, string>();
  for (const h of hits) for (const [p, val] of h.decls) out.set(p, val);
  return out;
}

/** Evaluate a length to px. Supports px, vw, vh, calc(), min(), max(),
 * var() and env(safe-area-inset-*); anything else throws. */
function px(value: string, vp: Viewport, vars: Map<string, string>): number {
  const env: Record<string, number> = {
    "safe-area-inset-top": vp.safe[0],
    "safe-area-inset-right": vp.safe[1],
    "safe-area-inset-bottom": vp.safe[2],
    "safe-area-inset-left": vp.safe[3],
  };
  const tokens =
    value.match(/\d*\.?\d+(px|vw|vh)?|[a-z-]+\(|[a-z][\w-]*|--[\w-]+|[-+*/(),]|\S/g) ?? [];
  let k = 0;
  const peek = () => tokens[k];
  const next = () => {
    const t = tokens[k++];
    if (t === undefined) throw new Error(`unexpected end of ${value}`);
    return t;
  };
  const expect_ = (t: string) => {
    if (next() !== t) throw new Error(`expected ${t} in ${value}`);
  };
  const args = (): number[] => {
    const list = [sum()];
    while (peek() === ",") {
      next();
      list.push(sum());
    }
    expect_(")");
    return list;
  };
  const atom = (): number => {
    const t = next();
    if (t === "(" || t === "calc(") {
      const v = sum();
      expect_(")");
      return v;
    }
    if (t === "min(") return Math.min(...args());
    if (t === "max(") return Math.max(...args());
    if (t === "var(") {
      const name = next();
      expect_(")");
      const raw = vars.get(name);
      if (raw === undefined) throw new Error(`undefined ${name}`);
      return px(raw, vp, vars);
    }
    if (t === "env(") {
      const name = next();
      const v = env[name];
      if (v === undefined) throw new Error(`unknown env ${name}`);
      // Skip the fallback: the viewport's insets are always defined here.
      while (next() !== ")");
      return v;
    }
    if (t === "-") return -atom();
    const m = t.match(/^(\d*\.?\d+)(px|vw|vh)?$/);
    if (!m) throw new Error(`unknown token ${t} in ${value}`);
    const n = Number(m[1]);
    if (m[2] === "vw") return (n * vp.w) / 100;
    if (m[2] === "vh") return (n * vp.h) / 100;
    return n; // px, or a unitless multiplier (`2 * var(--x)`)
  };
  const product = (): number => {
    let v = atom();
    while (peek() === "*" || peek() === "/") {
      const op = next();
      const r = atom();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  if (k !== tokens.length) throw new Error(`trailing tokens in ${value}`);
  if (!Number.isFinite(v)) throw new Error(`${value} is not finite`);
  return v;
}

/** The custom properties in force on body.touch. */
const varsFor = (vp: Viewport) => {
  const vars = computed(vp, [":root", "body.touch"]);
  for (const k of [...vars.keys()]) if (!k.startsWith("--")) vars.delete(k);
  return vars;
};

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A position:absolute/fixed element's box from its insets and size. */
function box(vp: Viewport, matches: readonly string[]): Box {
  const style = computed(vp, matches);
  const vars = varsFor(vp);
  const get = (p: string) => {
    const raw = style.get(p);
    return raw === undefined || raw === "auto" ? null : px(raw, vp, vars);
  };
  const span = (
    lo: number | null,
    hi: number | null,
    size: number | null,
    total: number,
    what: string,
  ): [number, number] => {
    if (lo !== null && size !== null) return [lo, lo + size];
    if (hi !== null && size !== null) return [total - hi - size, total - hi];
    if (lo !== null && hi !== null) return [lo, total - hi];
    throw new Error(`${matches.join(" | ")}: no ${what} extent`);
  };
  const [left, right] = span(
    get("left"),
    get("right"),
    get("width"),
    vp.w,
    "x",
  );
  const [top, bottom] = span(
    get("top"),
    get("bottom"),
    get("height"),
    vp.h,
    "y",
  );
  for (const v of [left, right, top, bottom])
    expect(Number.isFinite(v)).toBe(true);
  return { left, top, right, bottom };
}

/** Every selector that matches each thumb control under body.touch. */
const CONTROLS: Record<string, string[]> = {
  throttle: ["#touch-ui .tc", "#touch-throttle"],
  fire: ["#touch-ui .tc", "#touch-fire"],
  boost: ["#touch-ui .tc", "#touch-boost"],
  zoom: ["#touch-ui .tc", "#touch-zoom"],
};

/** The ≡ icon: a static child of the #touch-icons column (its only one). */
function scoreIcon(vp: Viewport): Box {
  const col = computed(vp, ["#touch-icons"]);
  const icon = computed(vp, ["#touch-ui .tc", "#touch-icons .tc"]);
  const vars = varsFor(vp);
  const right = px(col.get("right") as string, vp, vars);
  const top = px(col.get("top") as string, vp, vars);
  const w = px(icon.get("width") as string, vp, vars);
  const h = px(icon.get("height") as string, vp, vars);
  return { left: vp.w - right - w, right: vp.w - right, top, bottom: top + h };
}

const overlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const NOTCH: Viewport["safe"] = [0, 44, 21, 44];
/** Short landscape screens (the max-height: 340px layout), with and without
 * a notch: an iPhone SE-class Safari tab, windowed Android, an in-app
 * browser at the breakpoint. */
const SHORT: Viewport[] = [
  [568, 320],
  [640, 300],
  [640, 320],
  [667, 340],
  [844, 340],
].flatMap(([w, h]) => [
  { w: w as number, h: h as number, safe: [0, 0, 0, 0] as Viewport["safe"] },
  { w: w as number, h: h as number, safe: NOTCH },
]);
/** Just above the breakpoint: the regular touch layout must fit too. */
const TALLER: Viewport[] = [
  { w: 740, h: 360, safe: [0, 0, 0, 0] },
  { w: 812, h: 375, safe: NOTCH },
];
const name = (vp: Viewport) => `${vp.w}×${vp.h}${vp.safe[1] ? " notch" : ""}`;

describe("M9 touch layout: the controls fit the screen", () => {
  it("the stylesheet model sees the short-screen block", () => {
    const short = SHORT[0] as Viewport;
    expect(mediaMatches("@media (max-height: 340px)", short)).toBe(true);
    expect(varsFor(short).get("--mini")).toBe("80px");
    expect(varsFor(TALLER[0] as Viewport).get("--mini")).toBe("96px");
    // BOOST moves beside FIRE on a short screen.
    expect(box(short, CONTROLS.boost as string[]).left).toBeGreaterThan(
      box(short, CONTROLS.fire as string[]).right,
    );
  });

  for (const vp of [...SHORT, ...TALLER]) {
    it(`${name(vp)}: inside the safe area, under the top band, no two overlapping`, () => {
      const [st, sr, sb, sl] = vp.safe;
      const band = px("var(--hud-top-band)", vp, varsFor(vp));
      const boxes: [string, Box][] = [
        ...Object.entries(CONTROLS).map(
          ([k, sel]) => [k, box(vp, sel)] as [string, Box],
        ),
        ["score", scoreIcon(vp)],
      ];
      for (const [k, b] of boxes) {
        const where = `${name(vp)} ${k}`;
        expect(b.left, where).toBeGreaterThanOrEqual(sl);
        expect(b.right, where).toBeLessThanOrEqual(vp.w - sr);
        expect(b.top, where).toBeGreaterThanOrEqual(Math.max(st, band));
        expect(b.bottom, where).toBeLessThanOrEqual(vp.h - sb);
        expect(b.bottom - b.top, where).toBeGreaterThan(0);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const [a, ba] = boxes[i] as [string, Box];
          const [b, bb] = boxes[j] as [string, Box];
          expect(overlap(ba, bb), `${name(vp)} ${a} × ${b}`).toBe(false);
        }
      }
    });
  }
});

describe("M9 touch targets are at least 44 px", () => {
  for (const vp of [SHORT[0] as Viewport, TALLER[0] as Viewport]) {
    it(`${name(vp)}: FIRE, BOOST, ZOOM, the throttle and the ≡ icon`, () => {
      for (const [k, sel] of Object.entries(CONTROLS)) {
        const b = box(vp, sel);
        expect(b.right - b.left, k).toBeGreaterThanOrEqual(44);
        expect(b.bottom - b.top, k).toBeGreaterThanOrEqual(44);
      }
      const icon = scoreIcon(vp);
      expect(icon.right - icon.left).toBeGreaterThanOrEqual(44);
      expect(icon.bottom - icon.top).toBeGreaterThanOrEqual(44);
    });

    it(`${name(vp)}: the 28 px fullscreen / settings icons get 44 px hit areas that never overlap`, () => {
      const vars = varsFor(vp);
      const hit = (id: string): Box => {
        const el = box(vp, [`#${id}`, `body.touch #${id}`]);
        const slop = computed(vp, [`body.touch #${id}::before`]);
        const w = px(slop.get("width") as string, vp, vars);
        const h = px(slop.get("height") as string, vp, vars);
        expect(slop.get("left")).toBe("calc(50% - 22px)");
        expect(slop.get("top")).toBe("calc(50% - 22px)");
        const cx = (el.left + el.right) / 2;
        const cy = (el.top + el.bottom) / 2;
        return {
          left: cx - w / 2,
          right: cx + w / 2,
          top: cy - h / 2,
          bottom: cy + h / 2,
        };
      };
      const fs = hit("fs-btn");
      const settings = hit("settings-btn");
      for (const b of [fs, settings]) {
        expect(b.right - b.left).toBeGreaterThanOrEqual(44);
        expect(b.bottom - b.top).toBeGreaterThanOrEqual(44);
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(vp.w);
        expect(b.top).toBeGreaterThanOrEqual(0);
      }
      expect(overlap(fs, settings)).toBe(false);
    });
  }

  it("the chips (re-enter, install) are 44 px tall to the thumb, the dismiss 44 px wide", () => {
    const vp = SHORT[0] as Viewport;
    const slop = computed(vp, ["#fs-chips button::before"]);
    expect(
      px(slop.get("height") as string, vp, varsFor(vp)),
    ).toBeGreaterThanOrEqual(44);
    expect(slop.get("width")).toBe("100%");
    const dismiss = computed(vp, [
      "#fs-chips button",
      "#install-chip #install-dismiss",
    ]);
    expect(
      px(dismiss.get("min-width") as string, vp, varsFor(vp)),
    ).toBeGreaterThanOrEqual(44);
  });
});

describe("M9 no accidental mode switches, readable touch text", () => {
  it("the aim-mode and sensitivity icons are gone from the touch controls", () => {
    expect(html).not.toMatch(/id="touch-aim-mode"/);
    expect(html).not.toMatch(/id="touch-sens"/);
    expect(html).toMatch(/id="touch-score"/);
  });

  it("radio and GFX toggles are hidden on touch", () => {
    const style = computed(SHORT[0] as Viewport, [
      "body.touch #radio-toggle",
      "body.touch #quality-toggle",
    ]);
    expect(style.get("display")).toBe("none");
  });

  it("no touch HUD or control text is under 11 px", () => {
    let checked = 0;
    for (const r of rules) {
      const touch = r.selectors.some(
        (s) => s.startsWith("body.touch") || s.startsWith("#touch-"),
      );
      if (!touch) continue;
      for (const [p, val] of r.decls) {
        if (p !== "font-size") continue;
        checked++;
        expect(
          Number.parseFloat(val),
          `${r.selectors.join(", ")}`,
        ).toBeGreaterThanOrEqual(11);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

// Markup/CSS contract for the aim chrome (ANGE-G9CPCV, approved Concept 1
// "Classic Gunsight"). The pipper and the hitmarker are no longer CSS-pinned
// to screen centre — they are PROJECTED, because the chase camera looks ~10°
// below the gun line and a centred crosshair is therefore decorative, not
// truthful. Read as text: the node test env has no DOM (same as
// fullscreen-markup.test.ts).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** One `selector { … }` declaration block. */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`${esc} \\{[^}]*\\}`));
  expect(m, `${selector} rule present`).not.toBeNull();
  return (m as RegExpMatchArray)[0];
}

describe("pipper is projected, not pinned", () => {
  it("anchors #crosshair at the origin and drives it by transform", () => {
    const css = block("#crosshair");
    expect(css).toContain("left: 0");
    expect(css).toContain("top: 0");
    expect(css).toContain("will-change: transform");
  });

  it("no longer pins #crosshair to screen centre", () => {
    expect(block("#crosshair")).not.toContain("left: 50%");
  });

  it("moves #hitmarker with it — it lands 'at the reticle'", () => {
    const css = block("#hitmarker");
    expect(css).toContain("left: 0");
    expect(css).toContain("top: 0");
    expect(css).not.toContain("left: 50%");
  });

  it("draws the gunsight ring and its four ticks as inline SVG", () => {
    const m = html.match(/<svg[^>]*id="crosshair"[\s\S]*?<\/svg>/);
    expect(m, "#crosshair svg present").not.toBeNull();
    const svg = (m as RegExpMatchArray)[0];
    expect(svg).toContain('class="ring"');
    expect(svg.match(/class="tick"/g)).toHaveLength(4);
  });
});

describe("lead reticle firing-solution state", () => {
  it("reads as dashed while merely tracking", () => {
    expect(block("#lead .ring")).toContain("stroke-dasharray");
  });

  it("closes to a solid, filled, glowing ring on solution", () => {
    // A shape change, not just a brightness change — brightness alone loses
    // against a bloomed facade at BLOOM_THRESHOLD 0.72.
    expect(html).toContain("#lead.solution .ring");
    expect(block("#lead.solution .ring")).toContain("stroke-dasharray: none");
    expect(block("#lead.solution .core")).toMatch(/opacity: (?!0;)/);
    expect(block("#lead.solution")).toContain("drop-shadow");
  });

  it("converges four brackets that are invisible while cold", () => {
    expect(block("#lead .brk")).toContain("opacity: 0");
    expect(html).toContain("#lead.solution .brk");
  });
});

describe("body classes", () => {
  it("brightens the pipper while zoomed", () => {
    expect(html).toContain("body.zoom #crosshair");
  });

  it("still dims the aim chrome mid-orbit (free-look, B2)", () => {
    expect(html).toContain("body.freelook #crosshair");
    expect(html).toContain("body.freelook #lead");
  });
});

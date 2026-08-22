// Markup/CSS contract for the fullscreen toggle (ANGE-DOQ5V0). The button
// once rendered as a solid teal block: the ⛶ text glyph fell back to an
// emoji/boxed font AND the join card's bare `#join button` rule (solid
// background + padding) out-specified `.fs-toggle` on #join-fs. The fix is
// pure index.html markup/CSS, so the regression net reads the file as text —
// no DOM needed in the node test env.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** The inner markup of one <button> by id. */
function buttonMarkup(id: string): string {
  const match = html.match(
    new RegExp(`<button[^>]*id="${id}"[\\s\\S]*?</button>`),
  );
  expect(match, `#${id} button present`).not.toBeNull();
  return (match as RegExpMatchArray)[0];
}

describe("fullscreen toggle markup", () => {
  it("carries no font-dependent ⛶ glyph anywhere (U+26F6 fallback bug)", () => {
    expect(html.includes("⛶")).toBe(false);
  });

  for (const id of ["fs-btn", "join-fs"]) {
    it(`#${id} renders inline SVG enter + exit icons`, () => {
      const btn = buttonMarkup(id);
      expect(btn).toContain('class="icon-enter"');
      expect(btn).toContain('class="icon-exit"');
      expect(btn.match(/<svg/g)).toHaveLength(2);
    });
  }
});

describe("fullscreen toggle CSS hardening", () => {
  /** The `.fs-toggle { … }` declaration block. */
  const base = html.match(/\.fs-toggle \{[^}]*\}/)?.[0] ?? "";

  it("resets UA button chrome (appearance, background, tap highlight)", () => {
    expect(base).toContain("appearance: none");
    expect(base).toContain("background: transparent");
    expect(base).toContain("-webkit-tap-highlight-color: transparent");
  });

  it("keeps a visible keyboard focus style instead of removing it", () => {
    expect(html).toContain(".fs-toggle:focus-visible");
  });

  it("swaps enter/exit icons via body.fullscreen", () => {
    expect(html).toContain("body.fullscreen .fs-toggle .icon-enter");
    expect(html).toContain("body.fullscreen .fs-toggle .icon-exit");
  });

  it("scopes the join card's solid button style to the submit button only", () => {
    // A bare `#join button` selector also matches #join-fs and out-specifies
    // .fs-toggle — that was the solid teal block.
    expect(html).toContain('#join button[type="submit"]');
    expect(html).not.toMatch(/#join (button|form button) \{/);
  });
});

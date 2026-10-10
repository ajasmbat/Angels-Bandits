// DT2 pixel font: a 3 × 5 block alphabet for the dressing that spells words
// out of instanced boxes — the neon roof signs (roof-details.ts) and the
// graffiti throw-ups (facade-detail.ts). Pure data, THREE-free.
//
// A word is laid out as horizontal RUNS (one box per run of lit cells in a
// row), not one box per cell, so a five-letter sign is ~35 boxes rather
// than ~60, and a run never leaves a hairline seam between two cells.

/** Cells per glyph, across and down. */
export const GLYPH_W = 3;
export const GLYPH_H = 5;
/** Empty cells between two glyphs. */
export const GLYPH_GAP = 1;

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", ".#.", ".#."],
  W: ["#.#", "#.#", "#.#", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
};

/** One horizontal run of lit cells: row 0 is the TOP row, columns count
 * from the word's left edge (as its reader sees it), `len` cells long. */
export interface GlyphRun {
  row: number;
  col: number;
  len: number;
}

/** Width of a word in cells (glyphs plus the gaps between them). */
export const wordCells = (word: string): number =>
  word.length * (GLYPH_W + GLYPH_GAP) - GLYPH_GAP;

/** Every lit run of `word` (unknown characters draw as a space). */
export function wordRuns(word: string): GlyphRun[] {
  const runs: GlyphRun[] = [];
  for (let i = 0; i < word.length; i++) {
    const glyph = GLYPHS[word[i] as string];
    if (!glyph) continue;
    const left = i * (GLYPH_W + GLYPH_GAP);
    glyph.forEach((line, row) => {
      let start = -1;
      for (let c = 0; c <= GLYPH_W; c++) {
        const lit = c < GLYPH_W && line[c] === "#";
        if (lit && start < 0) start = c;
        if (!lit && start >= 0) {
          runs.push({ row, col: left + start, len: c - start });
          start = -1;
        }
      }
    });
  }
  return runs;
}

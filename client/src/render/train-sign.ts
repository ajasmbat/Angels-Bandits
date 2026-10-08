// T2 destination signs: a tiny 5×7 dot-matrix font, rasterised once into a
// one-channel bitmap the train shader samples as LEDs (each texel one dot).
// Pure — no canvas, no DOM — so it is the same bitmap on every client and
// in node.

/** Glyph rows, top first, 5 bits each (bit 4 = leftmost column). */
const FONT: Record<string, readonly number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0],
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
};
const GLYPH_W = 5;
const GLYPH_H = 7;
/** A glyph plus one dark column. */
const ADVANCE = GLYPH_W + 1;
/** One text row plus one dark row. */
export const SIGN_ROW_HEIGHT = GLYPH_H + 1;
/** Characters per row: every row is padded to this, so a marquee that
 * scrolls modulo the bitmap width loops seamlessly. */
export const SIGN_CHARS = 16;
export const SIGN_WIDTH = SIGN_CHARS * ADVANCE;

/** What line `line`'s track `track` shows: the line letter and its loop. */
export const signText = (line: number, track: number): string =>
  `${line === 0 ? "A" : "B"} ${track === 0 ? "OUTER" : "INNER"} LOOP`;

/** Row `line * 2 + track` of the sign bitmap holds that track's text. */
export const signRow = (line: number, track: number): number =>
  line * 2 + track;

/**
 * Rasterise `rows` texts (upper case; unknown characters are blank) into a
 * SIGN_WIDTH × rows·SIGN_ROW_HEIGHT bitmap, 255 = lit dot. Row 0 is at the
 * TOP of the bitmap (v = 0 in the shader is row 0's top line).
 */
export function signBitmap(rows: readonly string[]): {
  data: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
} {
  const width = SIGN_WIDTH;
  const height = rows.length * SIGN_ROW_HEIGHT;
  const data = new Uint8Array(width * height);
  rows.forEach((text, r) => {
    const padded = text.toUpperCase().padEnd(SIGN_CHARS).slice(0, SIGN_CHARS);
    for (let c = 0; c < padded.length; c++) {
      const glyph = FONT[padded[c] as string] ?? (FONT[" "] as number[]);
      for (let y = 0; y < GLYPH_H; y++) {
        const bits = glyph[y] ?? 0;
        for (let x = 0; x < GLYPH_W; x++) {
          if (!(bits & (1 << (GLYPH_W - 1 - x)))) continue;
          data[(r * SIGN_ROW_HEIGHT + y) * width + c * ADVANCE + x] = 255;
        }
      }
    }
  });
  return { data, width, height };
}

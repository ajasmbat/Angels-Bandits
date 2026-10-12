# Mist and steam never meet a facade

There is no depth texture in the renderer, so a camera-facing sprite (a fog
puff, a steam puff) cannot fade itself where it passes through a wall. If
any part of a visible sprite crosses a building, the depth test cuts it
along a hard, straight line. L5 makes that line impossible instead.

**The sites that must agree:**

- `buildingClearance` / `clearanceAgainst` in `client/src/render/fogbanks.ts`.
  A puff of visible radius `r` keeps `smoothstep(r, r + soft, d)` of its
  alpha, where `d` is its distance to each STANDING building box (footprint ×
  `standingProfile(b).top`). Zero means a box is inside the sprite.
- The S5 fog banks (`FogBanks.update`, soft 12 m) and every steam puff
  (`Steam.update`, soft 2 m, each vent's neighbours cached) both go
  through it.
- The canyon mist does NOT. It is safe by construction instead:
  `MIST_SIZE_MAX / 2 + MIST_CROSS_MAX + 4 ≤ LOT_LINE`, the street contract's
  facade line (`common/src/city/street.ts`), is checked at module load.
- The sprite's visible radius: the fog puff's Gaussian reaches 0 at half its
  quad, and steam's radial texture at half its point. Steam's
  `MAX_FILL × distance` cap only ever shrinks it.

**What breaks when they disagree:**

- A puff texture with a wider falloff than `r` is cut by the walls the
  clearance thinks it misses.
- A canyon puff made bigger, or a building allowed past `LOT_LINE` (a new
  streetwall rule, an overhang), and the strands start slicing facades.
  The module-load check only knows `LOT_LINE`.
- Clearance boxes from the static `height` instead of the standing top, and
  a felled tower keeps parting the mist around nothing.

The ground is handled the same way: a puff is lifted until its sprite clears
the surface it rises from (steam's emitter lift, the banks' and strands'
ground clamps).

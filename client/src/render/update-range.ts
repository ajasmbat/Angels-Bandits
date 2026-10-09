// D6: `BufferAttribute.addUpdateRange` without its per-call allocation.
//
// three pushes a fresh `{ start, count }` for every range, every frame — on
// attributes rewritten every frame (debris, dust) that is garbage the frame
// loop never needed. Here each attribute keeps a small pool of range objects
// and reuses them: three merges an attribute's ranges in place at upload and
// then empties the list, so a pooled range is always written fresh before it
// is pushed, and is never in the list twice (slot k is pushed only while the
// list holds k ranges).

import type * as THREE from "three";

type Range = { start: number; count: number };
const pools = new WeakMap<THREE.BufferAttribute, Range[]>();

/** Queue [start, start + count) of `attr` for upload (array elements). */
export function pushUpdateRange(
  attr: THREE.BufferAttribute,
  start: number,
  count: number,
): void {
  let pool = pools.get(attr);
  if (!pool) {
    pool = [];
    pools.set(attr, pool);
  }
  const list = attr.updateRanges as Range[];
  const k = list.length;
  let range = pool[k];
  if (!range) {
    range = { start: 0, count: 0 };
    pool[k] = range;
  }
  range.start = start;
  range.count = count;
  list.push(range);
}

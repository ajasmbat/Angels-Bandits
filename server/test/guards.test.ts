// Shape guards for untrusted frames (S1): a table of what parses as JSON but
// must never reach a handler as if it were a ClientMsg / Pose / Vec3.

import { describe, expect, it } from "vitest";
import { isClientMsg, isPose, isQuat, isVec3 } from "../src/guards";

const VEC = { x: 1, y: 2, z: 3 };
const QUAT = { x: 0, y: 0, z: 0, w: 1 };
const POSE = { pos: VEC, quat: QUAT, speed: 65 };

describe("isClientMsg", () => {
  it.each([
    [null, false],
    [[], false],
    [["pose"], false],
    ["x", false],
    [42, false],
    [true, false],
    [{}, false],
    [{ type: 7 }, false],
    [{ type: null }, false],
    [{ type: "pose" }, true],
    [{ type: "bogus" }, true], // unknown types are dropped by dispatch, not here
    [{ type: "join", name: "Ace" }, true],
  ])("%j → %s", (v, ok) => {
    expect(isClientMsg(v)).toBe(ok);
  });
});

describe("isVec3 / isQuat", () => {
  it.each([
    [VEC, true],
    [undefined, false],
    [null, false],
    [5, false],
    [[1, 2, 3], false],
    [{ x: 1, y: 2 }, false],
    [{ x: "1", y: 2, z: 3 }, false],
    [{ x: Number.NaN, y: 2, z: 3 }, false],
    [{ x: Number.POSITIVE_INFINITY, y: 2, z: 3 }, false],
  ])("isVec3(%j) → %s", (v, ok) => {
    expect(isVec3(v)).toBe(ok);
  });

  it("isQuat needs all four finite components", () => {
    expect(isQuat(QUAT)).toBe(true);
    expect(isQuat({ x: 0, y: 0, z: 0 })).toBe(false);
    expect(isQuat(null)).toBe(false);
  });
});

describe("isPose", () => {
  it.each([
    [POSE, true],
    [{}, false],
    [1, false],
    [null, false],
    [{ pos: null, quat: QUAT, speed: 65 }, false],
    [{ pos: VEC, speed: 65 }, false],
    [{ pos: VEC, quat: null, speed: 65 }, false],
    [{ pos: VEC, quat: QUAT }, false],
    [{ pos: VEC, quat: QUAT, speed: "65" }, false],
    [{ pos: { x: "a", y: 1, z: 1 }, quat: QUAT, speed: 65 }, false],
  ])("%j → %s", (v, ok) => {
    expect(isPose(v)).toBe(ok);
  });
});

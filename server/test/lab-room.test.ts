// FL1 Flight Lab safety: lab values only ever apply in a lab room. A normal
// room keeps DEFAULT_TUNING and today's validation (it rejects lab-speed
// poses), normal joins never land in a lab room, the standing bot room is
// never one, lab rooms are capped, and whatever arrives in a `lab` message
// is clamped by the shared importer.

import {
  BOOST_MAX_SPEED,
  LAB_ROOM_CAP,
  MAX_SPEED,
  ROOM_CAP,
} from "@angels-bandits/common/constants";
import type { Pose } from "@angels-bandits/common/protocol";
import {
  DEFAULT_TUNING,
  TUNING_VERSION,
  exportTuning,
  sanitizeTuning,
  tuningSpec,
} from "@angels-bandits/common/tuning";
import { describe, expect, it } from "vitest";
import { Room, RoomManager } from "../src/room";
import { roomPoseCap, validatePose } from "../src/validate";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const pose = (x: number, speed: number): Pose => ({
  pos: { x, y: 300, z: 1000 },
  quat: { ...IDENTITY },
  speed,
});
const DT = 0.05;

/** A lab room tuned to an "Arcade jet"-class top speed. */
function fastLab(): Room {
  const lab = new Room("room-9", 42, true);
  const t = sanitizeTuning({ maxSpeed: 130, boostMaxSpeed: 185 });
  expect(lab.applyLab({ tuning: JSON.parse(exportTuning(t)) })).toBe(true);
  return lab;
}

describe("FL1 lab room: pose validation", () => {
  it("a normal room rejects a lab-speed pose the lab room accepts", () => {
    const normal = new Room("room-1", 42);
    const lab = fastLab();
    // The boost mirror's cap for a pilot that is not boosting: MAX_SPEED.
    const boostCap = MAX_SPEED;
    // 170 m/s, moving 170 · DT m: legal for the lab, impossible on main.
    const prev = pose(1000, 170);
    const claim = pose(1000 + 170 * DT, 170);
    expect(roomPoseCap(normal, boostCap)).toBe(boostCap);
    expect(
      validatePose(prev, claim, DT, roomPoseCap(normal, boostCap)).ok,
    ).toBe(false);
    expect(roomPoseCap(lab, boostCap)).toBe(185);
    expect(validatePose(prev, claim, DT, roomPoseCap(lab, boostCap)).ok).toBe(
      true,
    );
  });

  it("even while boosting, a normal room still caps at the boost mirror", () => {
    const normal = new Room("room-1", 42);
    expect(roomPoseCap(normal, BOOST_MAX_SPEED)).toBe(BOOST_MAX_SPEED);
    const prev = pose(1000, 170);
    expect(
      validatePose(
        prev,
        pose(1000 + 170 * DT, 170),
        DT,
        roomPoseCap(normal, BOOST_MAX_SPEED),
      ).ok,
    ).toBe(false);
  });

  it("lab tuning sent to a normal room changes nothing", () => {
    const normal = new Room("room-1", 42);
    const t = sanitizeTuning({ maxSpeed: 180, boostMaxSpeed: 260 });
    expect(
      normal.applyLab({ tuning: JSON.parse(exportTuning(t)), chaos: true }),
    ).toBe(false);
    expect(normal.labTuning).toEqual(DEFAULT_TUNING);
    expect(normal.labChaos).toBe(false);
    expect(roomPoseCap(normal, MAX_SPEED)).toBe(MAX_SPEED);
  });
});

describe("FL1 lab room: the lab message is clamped", () => {
  it("garbage values are dropped or clamped by the shared importer", () => {
    const lab = new Room("room-9", 42, true);
    lab.applyLab({
      tuning: {
        v: TUNING_VERSION,
        t: {
          maxSpeed: Number.NaN,
          boostMaxSpeed: 1e9,
          turnRate: "fast",
          notAField: 3,
        },
      },
    });
    expect(lab.labTuning.maxSpeed).toBe(DEFAULT_TUNING.maxSpeed);
    expect(lab.labTuning.boostMaxSpeed).toBe(tuningSpec("boostMaxSpeed").max);
    expect(lab.labTuning.turnRate).toBe(DEFAULT_TUNING.turnRate);
    expect("notAField" in lab.labTuning).toBe(false);
    expect(roomPoseCap(lab, MAX_SPEED)).toBe(tuningSpec("boostMaxSpeed").max);
  });

  it("an unimportable tuning (no version, newer version) is ignored", () => {
    const lab = fastLab();
    const before = { ...lab.labTuning };
    lab.applyLab({ tuning: { t: { maxSpeed: 40 } } });
    lab.applyLab({ tuning: { v: TUNING_VERSION + 1, t: { maxSpeed: 40 } } });
    lab.applyLab({ tuning: "nope" });
    expect(lab.labTuning).toEqual(before);
  });

  it("the chaos toggle only takes booleans", () => {
    const lab = new Room("room-9", 42, true);
    expect(lab.labChaos).toBe(false);
    lab.applyLab({ chaos: "yes" });
    expect(lab.labChaos).toBe(false);
    lab.applyLab({ chaos: true });
    expect(lab.labChaos).toBe(true);
  });
});

describe("FL1 lab room: room bookkeeping", () => {
  it("a lab joiner gets a room of their own, alone, with bots off", () => {
    const mgr = new RoomManager();
    const normal = mgr.join("p1", "Pilot 1");
    const lab = mgr.joinLab("l1", "Lab 1");
    expect(lab).not.toBeNull();
    expect(lab?.lab).toBe(true);
    expect(lab?.id).not.toBe(normal.id);
    expect(lab?.botTarget).toBe(0);
    expect(lab && mgr.desiredBots(lab)).toBe(0);
    // A second lab joiner never shares it.
    expect(mgr.joinLab("l2", "Lab 2")?.id).not.toBe(lab?.id);
  });

  it("a normal join never lands in a lab room — even asking for it by id", () => {
    const mgr = new RoomManager();
    const lab = mgr.joinLab("l1", "Lab 1");
    const normal = mgr.join("p1", "Pilot 1", lab?.id);
    expect(normal.lab).toBe(false);
    expect(normal.id).not.toBe(lab?.id);
    for (let i = 2; i <= ROOM_CAP + 3; i++) {
      expect(mgr.join(`p${i}`, `Pilot ${i}`).lab).toBe(false);
    }
    expect(lab?.humanCount).toBe(1);
  });

  it("the standing (bot-kept-alive) room is never a lab room", () => {
    const mgr = new RoomManager();
    const lab = mgr.joinLab("l1", "Lab 1");
    // The lab was listed first: ensureRoom still makes a normal room.
    const standing = mgr.ensureRoom();
    expect(standing.lab).toBe(false);
    expect(mgr.ensureRoom()).toBe(standing);
    expect(mgr.desiredBots(standing)).toBeGreaterThan(0);
    // A lab room its pilot just left winds its bots down to zero.
    if (lab) {
      lab.setBotTarget("l1", 5, 0);
      expect(mgr.desiredBots(lab)).toBe(5);
      lab.members.delete("l1");
      expect(mgr.desiredBots(lab)).toBe(0);
    }
  });

  it(`lab joins over LAB_ROOM_CAP (${LAB_ROOM_CAP}) are refused`, () => {
    const mgr = new RoomManager();
    for (let i = 0; i < LAB_ROOM_CAP; i++) {
      expect(mgr.joinLab(`l${i}`, "Lab")).not.toBeNull();
    }
    expect(mgr.joinLab("late", "Lab")).toBeNull();
    expect(mgr.roomOf("late")).toBeUndefined();
    // Normal joins are unaffected by the lab cap.
    expect(mgr.join("p1", "Pilot 1").lab).toBe(false);
    // A lab room freed by its pilot leaving makes room for the next.
    mgr.leave("l0");
    expect(mgr.joinLab("late", "Lab")).not.toBeNull();
  });
});

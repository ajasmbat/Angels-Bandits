// RESERVED: the single home for ALL client↔server message types.
//
// T3 (multiplayer presence) fills this in. Every wire message — join, pose
// updates up, snapshots down, combat events — is typed HERE and nowhere else,
// shared verbatim by client and server. JSON over ws for now; keeping every
// shape in this one file is what makes a binary encoder a later drop-in swap
// (PLAN.md → Networking).
export {};

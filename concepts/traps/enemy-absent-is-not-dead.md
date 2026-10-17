# A missing enemy is not a dead one

**The edit that looks right:** read a snapshot as the room's whole truth —
a plane missing from it is dead, loading or away, so hide it (W2's rule,
`remotes.ingest`); or build a squadron's wingmen from the anchor pose the
server holds, before it goes on the wire.

**Why it is wrong (E1):** snapshots are per client and interest managed
(`common/src/interest.ts`): an enemy is sent every tick only within
`IM_NEAR_M` of that client, every `IM_MID_EVERY`-th tick out to half the
world, and never beyond. Hiding an enemy the moment it is missing blinks
every mid-tier plane four times a second and drops whole squadrons at the
tier's edge. And a wingman is derived on every client from the
QUANTISED anchor (`expandSquadRow`); a server that flies its wingmen off
the float anchor shoots at a pose a few centimetres from the one drawn —
harmless once, but it breaks the rule that a row expands into exactly the
poses the server holds, which is what promotions and hit claims lean on.

**Do instead:** an enemy goes stale only after `IM_STALE_MS` without a row
(deaths still arrive as `death`); a human's absence still hides it at once
(humans ride every snapshot). The server poses every squadron through
`encodeSquadRow` → `decodeSquadRow` before `slotPoseInto`
(`server/src/squadrons.ts` `pose()`), the same functions the client runs.

**How to catch it:** `server/test/airforce.test.ts` (rows, tiers, late
joiners over a real socket), `common/test/squadron.test.ts` (a row expands
into exactly the server's slot poses) and
`client/test/airforce-interp.test.ts` (no pop through a promotion or a
rate switch).

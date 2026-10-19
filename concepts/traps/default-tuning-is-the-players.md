# DEFAULT_TUNING is the player's, not the constants'

**The edit that looks right:** make the plane turn tighter, brake harder or
boost faster by changing a value in `DEFAULT_TUNING` (`common/src/tuning.ts`),
or call a shared flight helper (`turnRadius`, `turnRateAt`, `stepFlight`,
`handlingRates`) without a tuning, on the theory that the default is "the
game" for everyone.

**Why it is wrong (F10, FC1):** `DEFAULT_TUNING` is the PLAYER's model. F10
gave the player a fast roll, a held bank and bank-and-pull; FC1 gave the player
sharper slow turns (`turnRateSlow` 1.8), a harder corner airbrake
(`cornerBrakeDecel` 30) and a punchier boost (`boostResponse` 2.2). The bots
fly `BOT_TUNING`, which is the defaults with F10's roll and FC1's physics
(`PRE_FC1_PHYSICS`) put back, so they fly bit for bit as the constants
describe. A helper called without a tuning reads the player's numbers. Two
places that were not about the player broke that way in FC1: the race
courses' `COURSE_REF_RADIUS`, which moved every course until it was pinned to
`BOT_TUNING`, and the cave-in test's fixed-gain pilot. A fixed gain becomes a
different loop when the plant's rate changes. The player's own pilots (the
instructor, the stick and the assists) normalise by the rates they get, so
they don't care.

**Do instead:**
- Change player physics in `DEFAULT_TUNING`. Add the old value to
  `PRE_FC1_PHYSICS` (or the equivalent for the next pass), so the bots and
  the "pre-fc1" preset keep it.
- Pass `BOT_TUNING` explicitly wherever the caller is a bot, a bot-like
  pilot, or a geometry both sides derive (courses).
- Pass the client's live `tuning` wherever the caller is the player.

**How to catch it:** `common/test/tuning-parity.test.ts` holds `BOT_TUNING` to
the frozen legacy model on every scenario. It also holds `DEFAULT_TUNING` with
the pre-FC1 physics put back to that model on the level ones. Also check
`server/test/bot-sim.test.ts` and `client/test/novice-*.test.ts`: their
non-F10 arms fly the player's physics with only the pre-F10 roll
(`PRE_F10_ROLL` in `novice-sim.ts`). `tools/flight-courses.ts` measures a
player-physics change on a novice pilot, before vs after.

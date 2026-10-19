# A missing enemy is not a dead one

**The edit that looks right:** read a snapshot as the room's whole truth —
a plane missing from it is dead, loading or away, so hide it (W2's rule,
`remotes.ingest`); or draw every enemy at the shared interpolation delay,
whatever rate its rows arrive at.

**Why it is wrong (E1, I1):** snapshots are per client and interest managed
(`common/src/interest.ts`): an enemy is sent every tick only within
`IM_FULL_M` (300 m, the fight) of that client, every `IM_MID_EVERY`-th tick
out to half the world, and never beyond. I1 made every air-force plane its
own row (no squadron rows), which is why the full rate stops at 300 m and
not past the far plane: 500 individual planes at E1's tiers cost a client
about 500 KB/s. Hiding an enemy the moment it is missing blinks every
mid-tier plane four times a second. And a 5 Hz plane drawn at the shared
delay runs past its newest row between rows and holds still: it steps.

**Do instead:** an enemy goes stale only after `IM_STALE_MS` without a row
(deaths still arrive as `death`); a human's absence still hides it at once
(humans ride every snapshot). The client draws an enemy past the full-rate
tier `IM_MID_LAG_MS` further back (`remotes.ts` `tierLag`, eased in from
`TIER_LAG_LEAD_M` inside the tier and out again at `TIER_LAG_RATE`), so it
is always between two rows; the extra staleness rides the hit claim's
declared delay (`extraDelayOf`). `IM_NEAR_M` is no longer a wire tier: it
is what a human can see, the range the AA and chaos layers look at the air
force within.

**How to catch it:** `server/test/airforce.test.ts` (individual rows, tiers,
late joiners over a real socket), `common/test/interest.test.ts` (500
individual enemies round one client under 250 KB/s) and
`client/test/airforce-interp.test.ts` (no pop through a promotion or a
rate switch).

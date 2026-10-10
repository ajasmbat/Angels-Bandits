# A1 performance audit

What costs the game time at runtime, measured where this runner can measure
it and read statically where it cannot, and the safe wins that shipped.
Every fix is behavior-identical, or identical within float rounding: no
visual change beyond noise and no gameplay change. The proofs are below.

The runner has **no GPU**. Chromium falls back to SwiftShader, so every
browser number here is a SwiftShader number: frames take 1–3 s, and
over 95 % of the main thread is spent blocked in GL. The machine was also
shared with other agents' perf runs (load average 40–90). So read the
browser rows as **relative** rankings. Read the server and wire rows as
real: Node does not care about the GPU. The M3 commands at the end are the
ones that settle the GPU questions.

## How to reproduce

```sh
# server tick + wire (no browser): 8 humans + 4 bots, every chaos layer on FAST
node tools/perf/server-tick.mjs --humans 8 --bots 4 --warmup 20 --seconds 60
node tools/perf/server-tick.mjs --humans 1 --bots 11 --cpu-prof /tmp/prof   # + a V8 profile
# client: where the main thread goes, from Chrome traces (unminified build reads best)
(cd client && npx vite build --minify false)
node tools/perf/run.mjs --no-build --runs 1 --res 0.25 \
  --segments chaos,tunnel,furball,boss,ruins --trace /tmp/traces
node tools/perf/trace-spikes.mjs --top 15 /tmp/traces/*.json
# the paired gate (prints the late-compile table too)
node tools/perf/run.mjs --runs 3 --ab-ref origin/main --segments chaos,tunnel,furball,boss,ruins
```

On a Linux box whose Playwright cache holds a different Chromium than the
pinned one, set `AB_CHROME` to its `chrome-headless-shell`.

__SERVER__

__NETWORK__

__CLIENT__

__GPU__

__HITCH__

__PAIRED__

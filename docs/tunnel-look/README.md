# U7 tunnel look — before / after

Every `tunnel-*` gallery view (`tools/perf/gallery-views.mjs`), before (main at
2769057, what the planner reviewed) on the left and after (U7) on the right.
`desktop/` is 1280×720 on High, `phone/` is the landscape phone profile
(844×390, touch UI, Mobile tier; `AB_GALLERY_DEVICE=phone`). Both were shot on
SwiftShader (this box has no GPU), at a pixel ratio of 1, deep night.

**Provenance.** The "after" shots come from the final build, except where its
software-GL renderer crashed under load on this shared box. Those views come
from the post-merge build `fa41aa0`, which has the same surface, water and
debris code; only the later perf trims differ (sparser vine leaves,
four-sided crystals, fewer floor ferns and bushes, corner occlusion moved
into the shader). They are desktop `tunnel-grotto`, `tunnel-portal`,
`tunnel-station`, `tunnel-cavein-warning` and `tunnel-cavein-rubble`, and
phone `tunnel-cavein-*`. Main's build crashed the same way on the same box,
and so did the staged cave-ins: sometimes their rocks were never drawn.

Reproduce:

```sh
npm run build -w client
AB_CHROME=<headless shell> AB_CHROME_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader" \
  AB_GALLERY_RES=1 AB_GALLERY_QUALITY=high node tools/perf/gallery.mjs out 8099 tunnel-mid
# phone: AB_GALLERY_DEVICE=phone AB_GALLERY_QUALITY=mobile
```

## Pixel pass

These figures come from the PNGs (sRGB). ">0.95" is the share of the frame
whose luma is above 0.95, light sources and HUD included. Saturation is mean
HSV saturation; ✓ marks a gain of at least 0.05. `tunnel-portal` and
`tunnel-river-mouth` look at the portals from outside, so they barely change.

### Desktop (High)

| view | >0.95 before | >0.95 after | mean luma before → after | mean sat before → after |
|---|---|---|---|---|
| tunnel-cavein-fall | 0.23 % | 0.03 % | 0.68 → 0.38 | 0.18 → 0.66 ✓ |
| tunnel-cavein-rubble | 0.57 % | 0.33 % | 0.68 → 0.38 | 0.18 → 0.64 ✓ |
| tunnel-cavein-warning | 0.30 % | 0.05 % | 0.69 → 0.38 | 0.18 → 0.66 ✓ |
| tunnel-exit | 0.00 % | 0.00 % | 0.55 → 0.34 | 0.18 → 0.25 ✓ |
| tunnel-garden | 1.58 % | 1.02 % | 0.71 → 0.47 | 0.19 → 0.43 ✓ |
| tunnel-grotto | 0.29 % | 0.14 % | 0.68 → 0.38 | 0.18 → 0.68 ✓ |
| tunnel-life-grotto | 0.65 % | 0.38 % | 0.70 → 0.40 | 0.18 → 0.63 ✓ |
| tunnel-life-lake | 0.00 % | 0.00 % | 0.58 → 0.40 | 0.56 → 0.60 |
| tunnel-life-mine | 0.33 % | 0.22 % | 0.66 → 0.39 | 0.20 → 0.51 ✓ |
| tunnel-life-platform | 0.28 % | 0.20 % | 0.67 → 0.44 | 0.18 → 0.33 ✓ |
| tunnel-life-works | 0.46 % | 0.31 % | 0.70 → 0.45 | 0.17 → 0.29 ✓ |
| tunnel-mid | 0.66 % | 1.23 % | 0.69 → 0.41 | 0.18 → 0.56 ✓ |
| tunnel-portal | 0.01 % | 0.01 % | 0.23 → 0.23 | 0.47 → 0.47 |
| tunnel-river-mouth | 0.08 % | 0.09 % | 0.20 → 0.18 | 0.53 → 0.56 |
| tunnel-station | 0.41 % | 0.19 % | 0.63 → 0.43 | 0.21 → 0.32 ✓ |

### Phone (Mobile tier)

| view | >0.95 before | >0.95 after | mean luma before → after | mean sat before → after |
|---|---|---|---|---|
| tunnel-cavein-fall | 0.06 % | 0.06 % | 0.42 → 0.24 | 0.09 → 0.63 ✓ |
| tunnel-cavein-rubble | 0.06 % | 0.06 % | 0.42 → 0.24 | 0.09 → 0.60 ✓ |
| tunnel-cavein-warning | 0.06 % | 0.06 % | 0.42 → 0.24 | 0.09 → 0.63 ✓ |
| tunnel-exit | 0.06 % | 0.06 % | 0.36 → 0.23 | 0.12 → 0.21 ✓ |
| tunnel-garden | 0.06 % | 0.06 % | 0.44 → 0.27 | 0.09 → 0.32 ✓ |
| tunnel-grotto | 0.06 % | 0.06 % | 0.43 → 0.24 | 0.08 → 0.65 ✓ |
| tunnel-life-grotto | 0.06 % | 0.06 % | 0.43 → 0.24 | 0.08 → 0.64 ✓ |
| tunnel-life-lake | 0.06 % | 0.06 % | 0.35 → 0.24 | 0.47 → 0.59 ✓ |
| tunnel-life-mine | 0.06 % | 0.06 % | 0.42 → 0.26 | 0.09 → 0.47 ✓ |
| tunnel-life-platform | 0.06 % | 0.06 % | 0.41 → 0.27 | 0.11 → 0.33 ✓ |
| tunnel-life-works | 0.06 % | 0.06 % | 0.43 → 0.28 | 0.08 → 0.19 ✓ |
| tunnel-mid | 0.06 % | 0.06 % | 0.43 → 0.26 | 0.09 → 0.48 ✓ |
| tunnel-portal | 0.06 % | 0.06 % | 0.16 → 0.18 | 0.44 → 0.47 |
| tunnel-river-mouth | 0.06 % | 0.06 % | 0.14 → 0.13 | 0.53 → 0.54 |
| tunnel-station | 0.06 % | 0.06 % | 0.41 → 0.27 | 0.11 → 0.32 ✓ |

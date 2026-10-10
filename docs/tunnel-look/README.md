# U7 tunnel look — before / after

Every `tunnel-*` gallery view (`tools/perf/gallery-views.mjs`), before (main at
2769057, what the planner reviewed) on the left and after (U7) on the right.
`desktop/` is 1280×720 on High, `phone/` is the landscape phone profile
(844×390, touch UI, Mobile tier; `AB_GALLERY_DEVICE=phone`). Both were shot on
SwiftShader (this box has no GPU), at a pixel ratio of 1, deep night.

Reproduce:

```sh
npm run build -w client
AB_CHROME=<headless shell> AB_CHROME_ARGS="--use-angle=swiftshader --enable-unsafe-swiftshader" \
  AB_GALLERY_RES=1 AB_GALLERY_QUALITY=high node tools/perf/gallery.mjs out 8099 tunnel-mid
# phone: AB_GALLERY_DEVICE=phone AB_GALLERY_QUALITY=mobile
```

## Pixel pass

These figures come from the final PNGs (sRGB). ">0.95" is the share of the
frame whose luma is above 0.95, light sources and HUD included. Saturation is
mean HSV saturation; ✓ marks a gain of at least 0.05. `tunnel-portal` and
`tunnel-river-mouth` look at the portals from outside, so they barely change.

### Desktop (High)

| view | >0.95 before | >0.95 after | mean luma before → after | mean sat before → after |
|---|---|---|---|---|
| tunnel-cavein-fall | 0.23 % | 0.02 % | 0.68 → 0.38 | 0.18 → 0.66 ✓ |
| tunnel-cavein-rubble | 0.57 % | 0.33 % | 0.68 → 0.38 | 0.18 → 0.64 ✓ |
| tunnel-cavein-warning | 0.30 % | 0.05 % | 0.69 → 0.38 | 0.18 → 0.66 ✓ |
| tunnel-exit | 0.00 % | 0.00 % | 0.55 → 0.34 | 0.18 → 0.25 ✓ |
| tunnel-garden | 1.58 % | 1.38 % | 0.71 → 0.47 | 0.19 → 0.44 ✓ |
| tunnel-grotto | 0.29 % | 0.14 % | 0.68 → 0.38 | 0.18 → 0.68 ✓ |
| tunnel-life-grotto | 0.65 % | 0.39 % | 0.70 → 0.40 | 0.18 → 0.64 ✓ |
| tunnel-life-lake | 0.00 % | 0.00 % | 0.58 → 0.40 | 0.56 → 0.60 |
| tunnel-life-mine | 0.33 % | 0.26 % | 0.66 → 0.39 | 0.20 → 0.55 ✓ |
| tunnel-life-platform | 0.28 % | 0.13 % | 0.67 → 0.44 | 0.18 → 0.32 ✓ |
| tunnel-life-works | 0.46 % | 0.31 % | 0.70 → 0.45 | 0.17 → 0.29 ✓ |
| tunnel-mid | 0.66 % | 0.61 % | 0.69 → 0.41 | 0.18 → 0.55 ✓ |
| tunnel-portal | 0.01 % | 0.01 % | 0.23 → 0.23 | 0.47 → 0.47 |
| tunnel-river-mouth | 0.08 % | 0.08 % | 0.20 → 0.20 | 0.53 → 0.53 |
| tunnel-station | 0.41 % | 0.19 % | 0.63 → 0.43 | 0.21 → 0.32 ✓ |

### Phone (Mobile tier)

| view | >0.95 before | >0.95 after | mean luma before → after | mean sat before → after |
|---|---|---|---|---|
| tunnel-cavein-fall | 0.06 % | 0.06 % | 0.42 → 0.24 | 0.09 → 0.63 ✓ |
| tunnel-cavein-rubble | 0.06 % | 0.06 % | 0.42 → 0.24 | 0.09 → 0.60 ✓ |
| tunnel-cavein-warning | 0.06 % | 0.06 % | 0.42 → 0.24 | 0.09 → 0.63 ✓ |
| tunnel-exit | 0.06 % | 0.06 % | 0.36 → 0.23 | 0.12 → 0.21 ✓ |
| tunnel-garden | 0.06 % | 0.06 % | 0.44 → 0.29 | 0.09 → 0.34 ✓ |
| tunnel-grotto | 0.06 % | 0.06 % | 0.43 → 0.24 | 0.08 → 0.65 ✓ |
| tunnel-life-grotto | 0.06 % | 0.06 % | 0.43 → 0.24 | 0.08 → 0.64 ✓ |
| tunnel-life-lake | 0.06 % | 0.06 % | 0.35 → 0.25 | 0.47 → 0.59 ✓ |
| tunnel-life-mine | 0.06 % | 0.06 % | 0.42 → 0.25 | 0.09 → 0.46 ✓ |
| tunnel-life-platform | 0.06 % | 0.06 % | 0.41 → 0.27 | 0.11 → 0.33 ✓ |
| tunnel-life-works | 0.06 % | 0.06 % | 0.43 → 0.27 | 0.08 → 0.22 ✓ |
| tunnel-mid | 0.06 % | 0.06 % | 0.43 → 0.26 | 0.09 → 0.48 ✓ |
| tunnel-portal | 0.06 % | 0.06 % | 0.16 → 0.16 | 0.44 → 0.45 |
| tunnel-river-mouth | 0.06 % | 0.06 % | 0.14 → 0.14 | 0.53 → 0.52 |
| tunnel-station | 0.06 % | 0.06 % | 0.41 → 0.26 | 0.11 → 0.35 ✓ |

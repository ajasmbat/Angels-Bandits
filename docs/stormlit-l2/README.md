# L2 Stormlit: the far skyline and the city glow, before and after

Each sheet has three columns: the matching crop of a reference render, main
before L2 (`7061222`), and this branch. Everything was shot with
`tools/perf/gallery.mjs` at 1280×720 on a GPU-less Linux box (SwiftShader,
load average 40–70 from other tickets), so the colours are right but no
frame rate here means anything.

Weather and the room's burn level are live in the gallery unless a view pins
them. Shots in the same row were taken minutes apart in separate sessions, so
rain, lightning and the burn can differ between before and after. Read the
far field and the horizon, not the near-city weather.

| sheet | what to look at |
|---|---|
| `reference-wide.jpg` | New view: 300 m over the river, looking along it. Before, the city stopped at the 800 m fog limit against an empty navy sky. After, the river runs on into the far city (waterfront lamps, bridge light chains), the street grid continues to the horizon, the far towers stand as dark silhouettes with lit windows, and the horizon glows warm under the sky. |
| `reference-wide-inferno.jpg` | The same view at burn 0.9: the far districts afire, the windows gone ember, the horizon glow hotter and redder. |
| `high-overview.jpg` | Kilometres of city out to the horizon, where there was haze. |
| `chase-rooftops.jpg` | From roof height, the far skyline stands above the near blocks right across the horizon, with a spire silhouette. |
| `street-low.jpg` | In the canyon the far field is almost all hidden by the near blocks, as it should be. The only change is a warmer horizon at the street's end. |
| `boss-closeup.jpg` | Behind the carrier, the far city and the glow fill what was empty fog. |

## Layered depth, and one deliberate gap

The long views now read near blocks → mid city (into the fog) → far skyline →
glowing horizon. Between the real city's fog (≈ 650–800 m) and the far city's
fade-in (to ≈ 1.25 km) there is a band that reads as a low mist bank. That is
deliberate. The far city is drawn just inside the fog limit (below), and it
has to start fog-coloured, or its inner edge would show as a ring.

Real buildings at 700–800 m are almost fully fogged. They stand in front of
the far city as soft fog-coloured silhouettes, like towers in mist in front of
a lit distance. That is how the fog has to compose with a far field drawn
behind it.

## How it works (the short version)

- **The shell.** The far city (true distance 0.8–5 km) is drawn along each
  vertex's own view ray at a compressed distance of 792–799.5 m, just inside
  the fog limit. Everything real at 800 m or more is exactly the fog colour,
  torus images that switch included, and always loses the depth test to it.
  So no wrap can ever show against the far city, and the camera's far plane
  (900 m) never clips it.
- **World-anchored.** It is placed on an unwrapped camera offset (the clouds'
  `CloudOffset`, with a 64 km period of 32 torus widths). It has true
  parallax, never jumps at the seam, and continues the real 200 m street grid
  and the river row.
- **Nothing pops.** Towers fade to the fog colour by 950 m, then sink to zero
  height while already fog-coloured. Spires do the same from 2.6 km in, so
  they recede into the fog and are never reached. Everything is exactly the
  fog colour again by R_out − 100 m, so there is no ring edge.
- **The glow is part of the fog colour.** It is added per view ray (peaking
  at the horizon) in the fog chunk (every fogged material), in the dome on
  both sides of the fog stop, and in the far skyline, so the sky still meets
  the fog exactly. The cloud masses' undersides take it too, strongest over
  the far city's dense districts. It is 0 inside the cloud deck and in dust,
  and hotter and redder with the inferno burn.

The contract is written up in `concepts/invariants/sky-meets-fog.md`.

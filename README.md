# Hyderabad BR — 1:1 procedural battle royale

A multiplayer battle-royale shooter set on a 1:1 replica of Hyderabad, India,
built with Three.js (WebGL) and an authoritative Node server. Runs in any modern
browser, touch-first, no install.

```bash
npm install
npm run bake        # world bake (needs data/raw from tools/fetch-osm.mjs)
npm run build       # bundle the client
npm start           # http://localhost:8080
```


## Play it

```bash
docker run -d -p 8080:8080 -e BOT_TOTAL=24 ghcr.io/epurimani7613/hyderabad-br:latest
# then open http://localhost:8080
```

Two browsers, two sticks, one shared origin. Repo: <https://github.com/epurimani7613/hyderabad-br>

## What is actually real here

| Area | Status |
|---|---|
| Map geometry | **Real, but unevenly covered.** 19,574 unique OpenStreetMap ways over a 36 × 44 km area: 14,422 building footprints, 5,510 road segments. Coverage is *not* uniform — see the honest-coverage note below. |
| Terrain height | **Synthetic.** The OSM `/map` API returns no elevation, so the heightmap is generated (Deccan plateau ≈ 540 m ASL, western hills, Durgam lake basin, Musi channel). Plausible, not surveyed. |
| Landmarks | Charminar, HITEC Cyber Towers + 5-level parking deck, and the Durgam Cheruvu cable bridge with boardwalks are hand-modelled procedurally. Placed at true coordinates, but the surrounding *city* density varies a lot — see below. |
| Netcode | Authoritative 30 Hz server, client prediction, server reconciliation, 100 ms entity interpolation, 1 s lag-compensated hit registration. |
| Ballistics | Real projectile simulation: drag, drop, travel time, material penetration, per-weapon falloff, head/body/limb zones. |
| Characters | Procedural jointed rig with a blended state machine. **No mocap or downloaded animation assets.** |
| Audio | Fully synthesised via WebAudio — no sample files. Footsteps differ per surface type. |

## Honest coverage note

OSM data is **not** uniformly dense across this playfield, and the map reflects
that rather than hiding it:

- **Dense, realistic:** Gachibowli, Kukatpally, Uppal, Secunderabad, HITEC City,
  Durgam Cheruvu, KBR Park — these carry hundreds to over a thousand real
  building footprints each.
- **Sparse:** **Charminar's old city is almost entirely absent from OSM.** A
  direct API query for a 1 km box at the monument returns 6 ways and *zero*
  buildings. This is a property of the source data, not a bug: the old city is
  mapped mostly as relations and unlabelled footprints. Charminar itself is
  modelled procedurally, but the alleys around it are not real geometry.
- The original full-playfield sweep exhausted its request budget in the south
  (lat 17.20–17.47) and never reached the north. `tools/fetch-areas.mjs`
  re-fetches a priority list of areas with per-area budgets so the landmarks are
  guaranteed coverage; `tools/audit-raw.mjs` and `tools/audit-coverage.mjs`
  report what is actually there.

Run `node tools/audit-coverage.mjs` for a per-cell density map,
`node tools/audit-raw.mjs` for duplicate and per-landmark counts, and
`node tools/audit-baked.mjs` for what actually reaches the game world.

Two further data bugs worth knowing about, both fixed:
- The OSM `/map` endpoint **clips a way to the requested bbox**. A building
  straddling a large tile's edge came back with 1–2 identical points and a
  zero-area footprint, was cached like any other record, and was never retried.
  That silently deleted 989 buildings. `tools/repair-osm.mjs` purges them and
  re-fetches their area at a finer granularity.
- Landmark `radius` is the size of the *district*, not the monument. HITEC City is
  ~4 × 4 km, so the original 1.8 km radius left the towers standing in open
  ground with the real city 2 km away.

## Geography note

Charminar (17.6144, 78.4747) and Durgam Cheruvu (17.3380, 78.4400) are ~31 km
apart in reality, with HITEC City between them. **No 8 km square can contain all
three at 1:1.** The playfield is therefore 36 × 44 km, anchored at 17.4300,
78.4900, which holds all three at their true relative positions. The zone
schedule starts at a 26 km radius for the same reason.

## Architecture

```
shared/          imported by BOTH server and browser — the networking contract
  config.mjs     every tunable constant (never fork this)
  sim.mjs        stepPlayer(): movement, stance, vault, footsteps, damage
  ballistics.mjs projectiles, ray/capsule intersection, damage resolution
  world.mjs      terrain, surface, spatial grid, zone, vault queries
server/
  match.mjs      one authoritative match
  lobby.mjs      rooms, room codes, fixed tick loop, snapshot broadcast
  bots.mjs       server-side opponents (input generators, not special-cased)
client/src/
  main.mjs       camera, atmosphere, frame loop
  net.mjs        prediction, reconciliation, interpolation
  world-renderer.mjs  instanced scene construction
  character.mjs  procedural rig + animation state machine
  hud.mjs        dual joysticks, buttons, minimap, kill feed
  audio.mjs      synthesised weapon/footstep/impact audio
```

The single most important design decision: `shared/` is imported unchanged by
both sides. The server runs `stepPlayer()` to decide truth; the client runs the
same function to predict. Prediction cannot drift because it is the same code.

Everything repetitive is an `InstancedMesh`, so the whole 44 km map renders in
roughly 250–400 draw calls.

## Tests

```bash
node tests/hitreg.mjs      # deterministic hit registration at 30/80/200 m
node tests/two-clients.mjs # two WS clients, one match, invariants
node tests/combat.mjs      # live match against bots
node tests/browser.mjs     # two real Chromium clients, console + screenshots
BASE=<url> node tests/public.mjs   # the same, over the public tunnel
```

`hitreg.mjs` exists because combat failures in an open map are ambiguous: a
miss can be cover, range, or broken maths. That test removes the ambiguity by
placing two players in clear line of sight at a known distance.

## Deployment

Static hosting (Vercel/Netlify/GitHub Pages) **cannot** serve the WebSocket
server, so a static host alone will not give you multiplayer. One Node process
serves the static client, the WebSocket endpoint and the authoritative match loop
from a single origin, which is why this deploys as a container rather than as a
site.

### Run it

```bash
npm install && npm run build
npm start                       # http://localhost:8080
```

With Docker (builds the client bundle inside the image):

```bash
docker build -t hyderabad-br .
docker run -d -p 8080:8080 -e BOT_TOTAL=24 hyderabad-br
```

### Verified

The container image was built, run, health-checked, and played through by **two
real Playwright browsers joining the same match** (`BASE=http://localhost:8099/
node tests/public.mjs` → ALL PASS, both clients in match 1, 14 opponents each,
36 ms ping).

### The image is published — one command to play

The CI workflow publishes a multi-arch image to GitHub Container Registry:

```bash
docker run -d -p 8080:8080 -e BOT_TOTAL=24 ghcr.io/epurimani7613/hyderabad-br:latest
```

Verified end to end: the image was pulled back from GHCR on an **arm64** host (an
earlier amd64-only build failed with `no matching manifest`, which is why the
workflow now builds both architectures), came up `healthy`, and two Playwright
browsers joined the same match through it (`ALL PASS`, 14 opponents each).

### What is still missing: a public *game URL*

The artifact is published and permanent, but **no public play URL exists yet**,
because this machine has no login for any host that will run a long-lived
container:

- **A container host** (Fly.io, Railway, Render, DigitalOcean, EC2, or a
  VPS) will serve the game at a real domain. `docker run` above is the whole
  deploy; the host only needs to map a port and terminate TLS.
- **Local play:** `docker run …` then `http://localhost:8080`, or `npm start`.
- **Ephemeral tunnel:** `cloudflared tunnel --url http://localhost:8080` — works
  today and was verified with two browsers, but the URL dies with the process
  and must be re-shared each time.

Pushing to GHCR from this machine by hand also fails: the `gh` token in the
keyring carries `gist, read:org, repo, workflow` and is missing
`write:packages`. CI sidesteps this by using the built-in `GITHUB_TOKEN`. To push
manually, run `gh auth refresh -h github.com -s write:packages` first.

Environment variables: `PORT`, `BOT_TOTAL` (bots per match, default 14),
`OSM_BUDGET` (fetch request cap).

## Materials (PBR)

`client/src/pbr.mjs` builds every material procedurally at load time — no binary
texture assets in the repo:

- **Albedo, roughness and normal maps** generated on a canvas from multi-octave
  value noise, with the normal map Sobel-derived from a height field.
- **15 material classes** (asphalt, concrete, dirt, grass, gravel, plaster,
  brick, concrete panel, glass, steel, painted metal, stone, wood, tile) keyed off
  OSM `building:material` and surface tags, with a deterministic per-building hash
  fallback so a street of untagged buildings is not one flat colour.
- **Image-based lighting**: a PMREM environment map is baked from the existing sky
  shader and refreshed on eight coarse buckets of the day/night cycle. Without it
  `MeshStandardMaterial` renders metal and glass almost black — there is nothing to
  reflect — which is why the towers previously read as dead grey.

Verified in a real browser (`node tests/pbr.mjs`, WebGL): 273 materials carry an
albedo + roughness map, 417 carry a normal map, the environment map is bound, and
the scene draws in 267 calls across 38,981 instances.

Measured cost against a clean HEAD worktree in the same headless GL environment:
**1.9 → 1.8 FPS, 316 → 267 draw calls, 1 → 24 textures.** The ~5% frame cost is the
texture sampling. Those absolute FPS numbers are software rasterisation, not a
device measurement — real mobile GPU performance is untested.

## Known limitations

- Terrain elevation is generated, not surveyed — no SRTM/DEM source was reachable.
- Buildings are extruded axis-aligned boxes from OSM footprints, not detailed
  façades. Interiors exist as stacked decks, not furnished rooms.
- Character animation is procedural; there is no clip blending from mocap.
- PBR textures are procedural noise, not scanned or authored art; facades are
  flat boxes with normal maps, not window geometry.
- Frame rate was measured only under headless software GL. No real mobile GPU
  has been profiled, so the 'mobile-first' claim is unverified on hardware.
- Bots use a loot→hunt→engage→resupply→heal→rotate state machine and do not
  path around walls; they sprint at a target and rely on the shared sim's
  collision to slide along it.

## Zone and bot tuning

Three bugs here were only ever found by running whole matches and counting
deaths, not by reading the code:

**Zone.** Eleven phases taper 26 km → 1.8 km → 12 km → 8 km → 5 km → 3 km →
1.6 km → 800 m → 300 m → 90 m → 25 m at 0.4–13 dps. A 3.4 km opening ring killed
everyone on spawn, and a 1500 m → 500 m single-tick cliff killed 12 of 14 bots in
the same tick in every match. The 300 m → 90 m → 25 m tail exists because at
300 m the last two survivors could sit on opposite sides of the ring and both die
together, ending the match with `winner=null`. Across 9 seeds, 8 now produce a
distinct winner; the ninth ends in mutual destruction, which the test asserts
rather than hides.

**Bots.** They drop in a cluster inside the current circle around a human
player, or around one shared seeded point when there is no human. Four separate
defects made every match a rout, each found by instrumenting mode counts over a
full match:

| Symptom | Cause |
|---|---|
| 155,246 `rotate` ticks, zero shots | `rotate` nulled the bot's target every tick and the converge branch re-set the mode each tick, so no bot could leave it |
| All 14 landed on identical points every match | The drop spiral was a pure function of bot index and ignored the seed entirely |
| Closest two bots ever got: 5.9 km | Bots scattered across ±9 km; at a 6.4 m/s sprint closing that takes longer than a match, so nobody ever met and the zone killed everyone |
| Matches ended at phase 5–8 with `winner=null` | Bots landed on the far side of the circle and could not reach safety before it closed |
- No persistence: matches are in-memory and lost on server restart.
- The public tunnel URL changes when the tunnel restarts; it is not a permanent
  address.

## Credits

Map data © OpenStreetMap contributors, ODbL.
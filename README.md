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

Static hosting (Vercel/Netlify/GitHub Pages) cannot serve the WebSocket server,
and a static host alone will not give you multiplayer. Run the Node server
somewhere that holds a connection, and put the client behind it:

- **Local / LAN:** `npm start`, then `http://<lan-ip>:8080`
- **Public tunnel:** `cloudflared tunnel --url http://localhost:8080`
- **Real deploy:** any VM or container host that runs `node server/index.mjs`.
  Set `PORT`, and put TLS in front (the client auto-selects `wss://` on https).

Environment variables: `PORT`, `BOT_TOTAL` (bots per match, default 14),
`OSM_BUDGET` (fetch request cap).

## Known limitations

- Terrain elevation is generated, not surveyed — no SRTM/DEM source was reachable.
- Buildings are extruded axis-aligned boxes from OSM footprints, not detailed
  façades. Interiors exist as stacked decks, not furnished rooms.
- Character animation is procedural; there is no clip blending from mocap.
- Bots use a simple loot→hunt→engage state machine and do not path around walls.
- No persistence: matches are in-memory and lost on server restart.
- The public tunnel URL changes when the tunnel restarts; it is not a permanent
  address.

## Credits

Map data © OpenStreetMap contributors, ODbL.
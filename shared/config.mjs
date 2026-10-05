
// Single source of truth for every magic number. Imported by BOTH the
// authoritative Node server and the browser client — if these ever diverge,
// prediction desyncs. Never fork this file.
export const TICK_HZ = 30;                 // authoritative sim rate
export const TICK_DT = 1 / TICK_HZ;
export const RENDER_INTERP_DELAY = 0.10;   // entity interpolation buffer (s)
export const LAG_COMP_WINDOW = 1.0;        // how far server rewinds for hit reg (s)
export const MAX_CLIENT_CATCHUP = 5;       // ticks a client may replay after a stall

// --- Map frame: 1:1 metres, anchored on Hyderabad ---
// Map frame. Hyderabad's three requested landmarks are NOT co-located in
// reality: Charminar (17.6144,78.4747) and Durgam Cheruvu (17.3380,78.4400) are
// ~31 km apart, and HITEC City sits between them. An 8 km square therefore
// cannot contain them at 1:1. These values define a 44 x 36 km playfield
// anchored so all three fall inside at their true relative geometry.
export const LAT0 = 17.4300;
export const LON0 = 78.4900;
export const M_PER_DEG_LAT = 111320;
export const M_PER_DEG_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
export const MAP_W = 36000;                // east-west extent (m)
export const MAP_H = 44000;                // north-south extent (m)
export const MAP_SIZE = Math.max(MAP_W, MAP_H);

// Named drop zones, in true map metres. The renderer, the zone/bot logic and
// the server spawner all read this one table.
//
// `radius` is the size of the DISTRICT, not the size of the monument. HITEC City
// is roughly 4 x 4 km of mixed commercial and residential, so a 1.8 km radius
// left the towers sitting in open ground with the real city 2 km away; these
// radii are sized from the actual extent of each area's building footprints in
// the OSM cache (see tools/audit-baked.mjs).
export const LANDMARKS = {
  charminar:   { lat: 17.6144, lon: 78.4747, label: 'Charminar Old City', radius: 1600 },
  hitec:      { lat: 17.4435, lon: 78.4690, label: 'HITEC City',        radius: 3200 },
  durgam:     { lat: 17.3380, lon: 78.4400, label: 'Durgam Cheruvu',    radius: 3000 },
  kbr:        { lat: 17.4125, lon: 78.4710, label: 'KBR Park',          radius: 1400 },
  assembly:   { lat: 17.4740, lon: 78.4700, label: 'Assembly',          radius: 1500 },
  secunder:   { lat: 17.4398, lon: 78.4983, label: 'Secunderabad',      radius: 1800 },
  kukatpally: { lat: 17.4430, lon: 78.4130, label: 'Kukatpally',        radius: 2000 },
  gachibowli: { lat: 17.4400, lon: 78.3480, label: 'Gachibowli',        radius: 2200 },
  uppal:      { lat: 17.4020, lon: 78.5600, label: 'Uppal',             radius: 1600 },
  begumpet:   { lat: 17.4230, lon: 78.4660, label: 'Begumpet',          radius: 1400 },
  mehdipatnam:{ lat: 17.4150, lon: 78.5100, label: 'Mehdipatnam',       radius: 1500 },
  sainikpuri: { lat: 17.4400, lon: 78.4900, label: 'Sainikpuri',        radius: 1800 },
};
export const TERRAIN_GRID = 256;           // heightmap resolution (cells per axis)

export const ZONE = {
  phaseCount: 11,
  // Radii are metres and MUST cover the playfield at phase 0: the map is
  // 36 x 44 km, so a 3.4 km opening circle would kill everyone on spawn.
  //
  // The tail is deliberately gentle-then-tight rather than a cliff. An earlier
  // schedule went 3600 -> 1500 -> 500, which snapped 1500 m down to 500 m in one
  // tick: everyone still inside the old circle but outside the new one took 14 dps
  // with no warning, and 12 bots died simultaneously in every match.
  schedule: [
    { r: 26000, hold: 120, dps: 0.4 },
    { r: 18000, hold: 90,  dps: 0.7 },
    { r: 12000, hold: 80,  dps: 1.2 },
    { r: 8000,  hold: 70,  dps: 2.0 },
    { r: 5000,  hold: 60,  dps: 3.5 },
    { r: 3000,  hold: 55,  dps: 5.0 },
    { r: 1600,  hold: 50,  dps: 7.0 },
    { r: 800,   hold: 45,  dps: 9.0 },
    { r: 300,   hold: 60,  dps: 11.0 },
    // Fast endgame shrink. With the last two survivors circling a 300 m ring
    // they could sit on opposite sides of it and both die in the same tick -
    // winner=null in 3 of 5 matches. These extra collapses force contact.
    { r: 90,    hold: 25,  dps: 12.0 },
    { r: 25,    hold: 30,  dps: 13.0 },
  ],
  warningLead: 30,   // seconds the next circle is shown before it starts closing
};

// --- Character ---
export const P = {
  radius: 0.38,
  height: 1.80,
  crouchHeight: 1.28,
  eye: 1.62,
  crouchEye: 1.15,
  walk: 3.1,
  sprint: 6.4,
  crouchSpeed: 1.9,
  adsSpeed: 2.0,
  accel: 42,
  airAccel: 6.5,
  friction: 11,
  gravity: -22.0,
  jumpVel: 7.1,
  // Freefall / parachute. Without a terminal velocity a 600 m drop reaches
  // 165 m/s, which is both wrong and makes landings look lethal.
  // Real BR: ~800 m of altitude, canopy descent ~25 m/s, so ~30 s total. The
  // steering window matters - that is when a player picks their landing.
  chuteTerminal: -25.0,        // ~90 km/h descent under canopy
  chuteGravityScale: 0.42,     // canopy slows the pull
  freefallTerminal: -54.0,     // ~195 km/h before the canopy opens
  chuteOpenAfter: 1.2,         // seconds of freefall before the canopy opens
  chuteDrift: 9.0,             // m/s horizontal drift under canopy
  chuteDriftMax: 900,          // cap on drift distance while steering a drop
  maxStep: 0.55,          // auto step-up height
  vaultMax: 1.35,         // contextual vault height
  maxHp: 100,
};

// --- Ammo / armour ---
export const AMMO = { '5.56': 30, '7.62': 20, '9mm': 30, '.45': 25, '12g': 10 };
export const ARMOR = { 1: 30, 2: 55, 3: 80 };   // durability pool
export const ARMOR_ABSORB = { 1: 0.40, 2: 0.60, 3: 0.72 }; // fraction of dmg soaked
export const HELMET = { 1: 0.30, 2: 0.45, 3: 0.58 };

// --- Weapons. dmg is body; headshot multiplier + limb falloff per weapon ---
export const WEAPONS = {
  AKM:    { cls:'AR',  ammo:'7.62', rpm:600,  dmg:49, hs:2.1, limb:0.88, mag:30, reload:2.6,
            spreadHip:4.2, spreadAds:0.85, recoil:2.35, recover:6.5, vel:715, drag:0.0016,
            penCost:0.55, falloffStart:220, falloffEnd:520, falloffMin:0.62, auto:false, bot:0.85 },
  M416:   { cls:'AR',  ammo:'5.56', rpm:690,  dmg:41, hs:2.0, limb:0.90, mag:30, reload:2.3,
            spreadHip:3.6, spreadAds:0.60, recoil:1.65, recover:5.6, vel:900, drag:0.0014,
            penCost:0.42, falloffStart:300, falloffEnd:650, falloffMin:0.70, auto:true, bot:0.6 },
  'SCAR-L': { cls:'AR',  ammo:'5.56', rpm:620,  dmg:43, hs:2.0, limb:0.90, mag:30, reload:2.35,
            spreadHip:3.9, spreadAds:0.70, recoil:1.80, recover:5.8, vel:870, drag:0.0014,
            penCost:0.45, falloffStart:280, falloffEnd:620, falloffMin:0.68, auto:true, bot:0.7 },
  SKS:    { cls:'DMR',  ammo:'7.62', rpm:300,  dmg:53, hs:2.3, limb:0.94, mag:10, reload:2.9,
            spreadHip:4.6, spreadAds:0.32, recoil:2.80, recover:6.0, vel:830, drag:0.0018,
            penCost:0.62, falloffStart:380, falloffEnd:800, falloffMin:0.75, auto:false, bot:0.3 },
  KAR98K: { cls:'SR',   ammo:'7.62', rpm:40,   dmg:79, hs:2.6, limb:0.97, mag:5,  reload:3.4,
            spreadHip:5.0, spreadAds:0.18, recoil:5.20, recover:7.0, vel:800, drag:0.0020,
            penCost:0.70, falloffStart:500, falloffEnd:1000, falloffMin:0.85, auto:false, bot:0.0 },
  MP5:    { cls:'SMG',  ammo:'9mm',  rpm:800,  dmg:26, hs:1.7, limb:0.86, mag:30, reload:2.1,
            spreadHip:3.2, spreadAds:0.85, recoil:1.10, recover:4.6, vel:400, drag:0.0022,
            penCost:0.22, falloffStart:90,  falloffEnd:230, falloffMin:0.45, auto:true, bot:0.9 },
  UMP45:  { cls:'SMG',  ammo:'.45',  rpm:600,  dmg:35, hs:1.8, limb:0.88, mag:25, reload:2.4,
            spreadHip:3.4, spreadAds:0.70, recoil:1.40, recover:5.0, vel:380, drag:0.0024,
            penCost:0.30, falloffStart:110, falloffEnd:260, falloffMin:0.50, auto:true, bot:0.7 },
  VECTOR: { cls:'SMG',  ammo:'.45',  rpm:1100, dmg:24, hs:1.6, limb:0.85, mag:19, reload:2.2,
            spreadHip:3.6, spreadAds:0.95, recoil:0.95, recover:4.2, vel:350, drag:0.0026,
            penCost:0.25, falloffStart:70,  falloffEnd:190, falloffMin:0.40, auto:true, bot:1.0 },
  M870:   { cls:'SG',   ammo:'12g',  rpm:180,  dmg:23, hs:1.5, limb:0.92, mag:5,  reload:0.6,
            spreadHip:6.5, spreadAds:3.20, recoil:3.40, recover:6.0, vel:380, drag:0.0060,
            penCost:0.14, falloffStart:35,  falloffEnd:110, falloffMin:0.28, auto:false, bot:5.0, pellets:9 },
  DP28:   { cls:'LMG',  ammo:'7.62', rpm:500,  dmg:45, hs:1.9, limb:0.90, mag:47, reload:4.2,
            spreadHip:4.8, spreadAds:1.10, recoil:1.70, recover:6.2, vel:780, drag:0.0018,
            penCost:0.58, falloffStart:280, falloffEnd:620, falloffMin:0.70, auto:true, bot:0.6 },
};

export const MEDS = {
  bandage:  { heal: 12,  time: 3.0, cap: 75,  max: 10 },
  firstaid: { heal: 100, time: 6.0, cap: 75,  max: 5 },
  medkit:   { heal: 100, time: 8.0, cap: 100, max: 3 },
  energy:   { heal: 0,  boost: 40, time: 3.0, cap: 100, max: 8 },
  painkill: { heal: 0,  boost: 60, time: 5.5, cap: 100, max: 4 },
};

export const BOOST_DECAY = 2.2;   // boost points/sec
export const HEADSHOT_MULT_CAP = 2.6;

// Surface types drive footstep audio + traction (requested: concrete/dirt/stone)
export const SURFACE = {
  concrete: { step:'concrete',  grip:1.00, loud:1.00 },
  asphalt:  { step:'asphalt',   grip:0.98, loud:0.95 },
  stone:    { step:'stone',     grip:0.96, loud:1.05 },
  dirt:     { step:'dirt',      grip:0.86, loud:0.70 },
  grass:    { step:'grass',     grip:0.90, loud:0.60 },
  metal:    { step:'metal',     grip:1.00, loud:1.25 },
  wood:     { step:'wood',      grip:0.92, loud:0.90 },
  water:    { step:'water',     grip:0.62, loud:1.10 },
};

// Penetration cost multipliers by material (bullet energy units)
export const MAT = {
  wood: 0.30, glass: 0.22, sheetmetal: 0.35, concrete: 1.0, brick: 1.15,
  stone: 1.30, steel: 2.4, dirt: 1.6, water: 0.8, foliage: 0.18, none: 0,
};

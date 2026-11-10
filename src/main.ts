import * as THREE from "three/webgpu";
import GUI from "three/examples/jsm/libs/lil-gui.module.min.js";
import Renderer from "three/src/renderers/common/Renderer.js";
import WebGPUBackend from "three/src/renderers/webgpu/WebGPUBackend.js";
import StandardNodeLibrary from "three/src/renderers/webgpu/nodes/StandardNodeLibrary.js";
import { FOOTSTEP, grassField, grassSettings, MAX_BLADE_HEIGHT, type GrassLook, type Push } from "./grass";
import { createGround } from "./ground";
import { createPlayer } from "./player";
import { createEnemies } from "./enemies";
import { createPost, greyscale, hdrBoost, TONE_MAPPINGS, updateShockwaves } from "./post";
import { loadBotAssets } from "./bot";
import { BoltPool } from "./bolts";
import { Stains } from "./stains";
import { ClusteredLighting } from "./lighting/ClusteredLighting";
import { ISO_OFFSET, ISO_UP, viewSize } from "./iso";
import { updatePaths } from "./worldMap";
import { createControls } from "./controls";

type ScenePreset = {
  background: string;
  fog?: { color: string; near: number; far: number };
  ambient: { color: string; intensity: number };
  light: { position: [number, number, number]; color: string; intensity: number };
  moon?: { position: [number, number, number]; radius: number; color: string };
  grass: GrassLook;
};

// Scenes the game could be set in; only the night one so far
const SCENES: Record<string, ScenePreset> = {
  Moon: {
    background: "#070b16",
    fog: { color: "#070b16", near: 60, far: 150 },
    ambient: { color: "#6e80d8", intensity: 1.25 },
    light: { position: [-49, 50, 7], color: "#b4d6c4", intensity: 1.45 },
    moon: { position: [-245, 250, 35], radius: 9, color: "#eef2ff" },
    grass: { specular: "#b8ccc0", shininess: 20, tipTint: [0.75, 0.85, 1.0], wetness: 1 },
  },
};

// The camera leads ahead of the character towards the mouse, so more of
// the view lies where it's looking. Eased slower than the follow, so it
// swings after a turn
const LOOK_AHEAD = 5; // metres
// Extra lead along the screen's vertical, which the view foreshortens
const LOOK_AHEAD_VERTICAL = 2.2;
const LOOK_AHEAD_RATE = 1.8; // per second
const FOLLOW_RATE = 4; // per second

// Blown apart, the world slows to a standstill and drains to black and
// white over DEATH_EASE seconds, and the game over screen shows after
// GAME_OVER_DELAY (seconds of real time), over the frozen frame
const DEATH_EASE = 1.2;
const GAME_OVER_DELAY = 1.4;

// Dev settings. On a 2x display, 1.5x resolution and no multisampling each
// take a large share of the GPU work. A 60 fps cap on a 120 Hz display
// halves the GPU's work; 0 runs at the display's rate. HDR output costs
// about a third of the frame, and is off for good on screens that can't
// show it, as is Display P3. Kept in localStorage, with the grass's
const hdrScreen = matchMedia("(dynamic-range: high)").matches;
const p3Screen = matchMedia("(color-gamut: p3)").matches;
const settings = {
  resolution: 2,
  msaa: true,
  fps: 60,
  hdr: hdrScreen,
  p3: p3Screen,
  hdrBoost: hdrBoost.value,
  toneMapping: "ACES Filmic",
  showFps: false,
};
const SAVED = "settings";
try {
  const saved = JSON.parse(localStorage.getItem(SAVED) ?? "{}");
  Object.assign(settings, saved.settings);
  Object.assign(grassSettings, saved.grass);
} catch {
  // Nothing saved, or storage blocked: defaults
}
settings.hdr &&= hdrScreen;
settings.p3 &&= p3Screen;
hdrBoost.value = settings.hdrBoost;
const save = () => {
  try {
    localStorage.setItem(SAVED, JSON.stringify({ settings, grass: grassSettings }));
  } catch {
    // Storage blocked: settings last until reload
  }
};

function outputType() {
  return settings.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
}

// The landing screen: its bar fills as assets load (most of it) and the
// shaders compile (the rest), then a start button takes its place
const bar = document.querySelector<HTMLElement>("#progress > div")!;
const progress = (fraction: number) => (bar.style.transform = `scaleX(${fraction})`);
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => progress(0.1 + (0.6 * loaded) / total);

// three's WebGPURenderer, minus its WebGL fallback: the grass needs
// compute shaders, which WebGL lacks
const rendererOptions = {
  // Multisampling is the scene pass's (see post); the canvas only gets the
  // finished image
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
  // Half-float canvas with extended tone mapping: HDR output on displays
  // and browsers that support it, plain SDR elsewhere
  outputType: outputType(),
} as const;
const renderer = new Renderer(new WebGPUBackend(rendererOptions), rendererOptions) as THREE.WebGPURenderer;
renderer.library = new StandardNodeLibrary();
// Point lights (the laser bolts) only shade the pixels they reach
renderer.lighting = new ClusteredLighting();
// three sets the canvas up without a colour space, so sRGB: this adds
// ours each time it does. (TypeScript's own types have no WebGPU, so just
// what's used here)
type CanvasConfig = Record<string, unknown>;
const gpuContext = renderer.domElement.getContext("webgpu") as unknown as {
  configure(config: CanvasConfig): void;
};
const configure = gpuContext.configure.bind(gpuContext);
gpuContext.configure = (config) => configure({ ...config, colorSpace: settings.p3 ? "display-p3" : "srgb" });
await renderer.init();
// The view: the whole window, or beside or above the sticks on touch
// screens (see index.html)
const viewElement = document.getElementById("view")!;
viewElement.prepend(renderer.domElement);
progress(0.1);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
camera.near = 1;
camera.far = 200;

const ambient = new THREE.AmbientLight();
const sun = new THREE.DirectionalLight();
const moon = new THREE.Mesh(
  new THREE.SphereGeometry(1, 32, 16),
  new THREE.MeshBasicNodeMaterial({ fog: false, lights: false })
);
scene.add(ambient, sun, moon);

const stains = new Stains();
// Everything that flattens the grass, and how: the player, enemies while
// around, and bolts in flight
const grassPushers = new Map<THREE.Vector3, Push>();
const bolts = new BoltPool(stains, grassPushers);
const [ground, botAssets] = await Promise.all([createGround(), loadBotAssets()]);
const player = createPlayer(botAssets, bolts, createControls(renderer.domElement));
const home = player.position.clone();
grassPushers.set(player.position, FOOTSTEP);
// Kills this life, shown bottom left and on the game over screen
let score = 0;
const setScore = (value: number) => (document.getElementById("score-value")!.textContent = String((score = value)));
const enemies = createEnemies(botAssets, bolts, grassPushers, player.position, () => setScore(score + 1));
const grass = grassField(renderer, stains, grassPushers, player.position);
scene.add(ground.mesh, grass.mesh, player.object, enemies.object, bolts.group);
progress(0.75);
const makePost = () => createPost(renderer, scene, camera, settings);
let post = makePost();
function rebuildPost() {
  post.dispose();
  post = makePost();
}

// Switches between HDR and plain output, and between Display P3 and sRGB.
// three sets up a canvas once per
// canvas target, reading the backend's output type, so this changes that
// and hands the same canvas over in a new target. Only the last pass draws
// to the canvas, so it's the only one rebuilt
function setOutput() {
  (renderer.backend as unknown as { parameters: { outputType: number } }).parameters.outputType = outputType();
  const old = renderer.getCanvasTarget();
  renderer.setCanvasTarget(new THREE.CanvasTarget(old.domElement));
  old.dispose();
  sizeCanvas();
  rebuildPost();
    boostControl.disable(!settings.hdr);
}

const preset = SCENES.Moon;
function applyScene() {
  scene.background = new THREE.Color(preset.background);
  scene.fog = preset.fog ? new THREE.Fog(preset.fog.color, preset.fog.near, preset.fog.far) : null;
  ambient.color.set(preset.ambient.color);
  ambient.intensity = preset.ambient.intensity;
  sun.position.fromArray(preset.light.position);
  sun.color.set(preset.light.color);
  sun.intensity = preset.light.intensity;
  ground.light.value.set(preset.light.color);
  moon.visible = !!preset.moon;
  if (preset.moon) {
    moon.position.fromArray(preset.moon.position);
    moon.scale.setScalar(preset.moon.radius);
    (moon.material as THREE.MeshBasicNodeMaterial).color.set(preset.moon.color);
  }
}

function sizeCanvas() {
  renderer.setPixelRatio(Math.min(settings.resolution, window.devicePixelRatio));
  renderer.setSize(viewElement.clientWidth, viewElement.clientHeight);
}

// While time stands still (see frame) the same picture would be drawn
// over and over, so it's only drawn again once something changes how it
// looks: redraw() asks for that
let stale = true;
function redraw() {
  stale = true;
}

function resize() {
  redraw();
  sizeCanvas();
  const size = viewSize(viewElement.clientWidth, viewElement.clientHeight);
  camera.top = size.height / 2;
  camera.bottom = -camera.top;
  camera.right = size.width / 2;
  camera.left = -camera.right;
  camera.updateProjectionMatrix();
  grass.rebuild(size.width, size.height);
}

applyScene();
resize();
window.addEventListener("resize", resize);

// Bottom right, closed until opened, and hidden while loading. The game
// pauses while it's open
const gui = new GUI({ title: "Settings" })
  .onChange(() => {
    save();
    redraw();
  })
  .close();
let paused = false;
gui.$title.addEventListener("click", () => (paused = !gui._closed));
Object.assign(gui.domElement.style, { top: "auto", bottom: "0" });
const graphicsGui = gui.addFolder("Graphics").close();
graphicsGui.add(settings, "resolution", { "2x": 2, "1.5x": 1.5, "1x": 1 }).name("Resolution").onChange(resize);
graphicsGui.add(settings, "msaa").name("MSAA 4x").onChange(rebuildPost);
graphicsGui.add(settings, "fps", { "60": 60, Display: 0 }).name("Frame rate cap");
graphicsGui.add(settings, "showFps").name("Show FPS").onChange(showFps);
graphicsGui.add(settings, "toneMapping", Object.keys(TONE_MAPPINGS)).name("Tone Mapping").onChange(rebuildPost);
graphicsGui.add(settings, "hdr").name("HDR").disable(!hdrScreen).onChange(setOutput);
graphicsGui.add(settings, "p3").name("Display P3").disable(!p3Screen).onChange(setOutput);
// How bright the bolts' cores, and their glow, burn past white, on HDR only
const boostControl = graphicsGui
  .add(settings, "hdrBoost", 0, 16, 0.5)
  .name("HDR Boost")
  .disable(!settings.hdr)
  .onChange((value: number) => (hdrBoost.value = value));
const grassGui = gui.addFolder("Grass Field").close();
grassGui.add(grassSettings, "density", 10, 200, 5).name("Density").onChange(resize);
grassGui.add(grassSettings, "bladeHeight", 0.7, MAX_BLADE_HEIGHT, 0.1).name("Blade Height");
grassGui.add(grassSettings, "windSpeed", 0, 5, 0.1).name("Wind Speed");
grassGui.add(grassSettings, "trailRecovery", 0.2, 20, 0.1).name("Trail Recovery");
grassGui.add(grassSettings, "bladeLit").name("Blade Lighting").onChange(resize);

// Where the game is: loading, the title screen, waiting for the player's
// first move (enemies held off), playing, dying (enemies standing down,
// slowing and draining to grey) and over, then back to waiting, which
// clears them and revives the player where it fell. On <body> too, which
// shows the screens
type Phase = "loading" | "title" | "waiting" | "playing" | "dying" | "over";
let phase: Phase = "loading";
let phaseTime = 0; // real seconds
function setPhase(next: Phase) {
  redraw();
  phase = next;
  phaseTime = 0;
  document.body.dataset.phase = next;
  if (next === "over") document.getElementById("final-score")!.textContent = `Blasted ${score}`;
  if (next !== "waiting") return;
  bolts.clear();
  enemies.clear();
  player.revive();
  home.copy(player.position);
  setScore(0);
}
let elapsed = 0;
const focus = new THREE.Vector3();
const lead = new THREE.Vector3();
const screenUp = new THREE.Vector3(ISO_UP[0], 0, ISO_UP[1]);
const view = new THREE.Vector3();

// Time stands still while loading, on the title screen, once the game is
// over and while settings are open
const timeStands = () => paused || phase === "loading" || phase === "title" || phase === "over";

function frame(delta: number) {
  if (timeStands()) delta = 0;
  phaseTime += delta;
  if (phase === "dying" && phaseTime >= GAME_OVER_DELAY) setPhase("over");
  const fade = phase === "over" ? 1 : phase === "dying" ? THREE.MathUtils.smoothstep(phaseTime, 0, DEATH_EASE) : 0;
  greyscale.value = fade;
  delta *= 1 - fade;
  if (delta > 0) {
    elapsed += delta;
    player.update(delta, camera);
    if (phase === "waiting" && player.position.distanceToSquared(home) > 0.01) setPhase("playing");
    if (phase === "playing") enemies.hunt(delta, camera);
    else if (phase !== "waiting") enemies.standDown(delta);
    bolts.update(delta);
    if (phase === "playing" && !player.alive) setPhase("dying");
  }

  // Glide after the character, leading towards the mouse
  focus.lerp(player.position, 1 - Math.exp(-delta * FOLLOW_RATE));
  view
    .copy(player.aim)
    .addScaledVector(screenUp, player.aim.dot(screenUp) * (LOOK_AHEAD_VERTICAL - 1))
    .multiplyScalar(LOOK_AHEAD);
  lead.lerp(view, 1 - Math.exp(-delta * LOOK_AHEAD_RATE));
  view.copy(focus).add(lead);
  camera.position.set(...ISO_OFFSET).add(view);
  camera.lookAt(view);
  camera.updateMatrixWorld();

  ground.mesh.position.set(player.position.x, -0.01, player.position.z);
  ground.time.value = elapsed;
  updatePaths(renderer, player.position);
  grass.update(delta, elapsed, scene, camera, preset.grass);
  updateShockwaves(camera, bolts.bursts());
  post.render();
}

// Driven by display refreshes, skipping some to hold the frame rate cap
let last = performance.now();
let burning = false;

// Frames drawn per second, counted only while shown, over half a second
const fpsText = document.getElementById("fps")!;
let fpsFrames = 0;
let fpsSince = 0;
function showFps() {
  fpsText.hidden = !settings.showFps;
  fpsFrames = 0;
  fpsSince = performance.now();
}
showFps();
function countFrame(now: number) {
  fpsFrames++;
  if (now - fpsSince < 500) return;
  fpsText.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} fps`;
  fpsFrames = 0;
  fpsSince = now;
}

requestAnimationFrame(function tick(now) {
  requestAnimationFrame(tick);
  // A little early is fine: refreshes never land exactly on the interval
  if (burning || now - last < (settings.fps ? 1000 / settings.fps - 2 : 0)) return;
  const delta = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (timeStands() && !stale) return;
  stale = false;
  frame(delta);
  if (settings.showFps) countFrame(now);
});

// Compiles every shader before play starts, while the loading screen
// covers the view: a rehearsal of what play draws, for a few frames. Every
// enemy arrives and poses (each has shaders of its own), the player fires,
// the blood pass runs painting nothing, and whatever else is hidden
// (idle bolts' lights, debris) shows. Then all of it is cleared away
const device = (renderer.backend as unknown as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } })
  .device;
const muzzle = new THREE.Vector3();
async function rehearse(onFrame?: (i: number) => void) {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (!object.visible) hidden.push(object);
  });
  for (const object of hidden) object.visible = true;
  enemies.rehearse(camera);
  bolts.fire("player", muzzle.copy(player.position).setY(1.2), player.aim);
  grass.compilePasses();
  for (let i = 0; i < 3; i++) {
    redraw();
    await new Promise(requestAnimationFrame);
    onFrame?.(i);
  }
  await device.queue.onSubmittedWorkDone();
  for (const object of hidden) object.visible = false;
  enemies.clear();
  bolts.clear();
  redraw();
}
await rehearse((i) => progress(0.8 + (0.15 * (i + 1)) / 3));
progress(1);
setPhase("title");
// Start and Respawn, or Enter while either shows
for (const id of ["start", "respawn"]) document.getElementById(id)!.addEventListener("click", () => setPhase("waiting"));
addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (phase === "title" || phase === "over")) setPhase("waiting");
  // F: the whole page full screen, screens and settings with it, and back
  if (event.code === "KeyF" && !event.repeat && !event.metaKey && !event.ctrlKey) {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }
});

// ?bench: window.__burn(frames) renders frames back to back, with no wait
// for the display, at a fixed 60 fps step, keeping two in flight on the GPU
// It skips the title screen
if (new URLSearchParams(location.search).has("bench")) {
  setPhase("waiting");
  Object.assign(window, {
    __scene: scene,
    __camera: camera,
    __burn: async (frames = 600) => {
      burning = true;
      await device.queue.onSubmittedWorkDone();
      let previous = Promise.resolve();
      const start = performance.now();
      for (let i = 0; i < frames; i++) {
        frame(1 / 60);
        const done = device.queue.onSubmittedWorkDone();
        await previous;
        previous = done;
      }
      await previous;
      const ms = (performance.now() - start) / frames;
      last = performance.now();
      burning = false;
      return { ms: +ms.toFixed(2), fps: Math.round(1000 / ms) };
    },
  });
}

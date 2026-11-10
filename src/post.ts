import * as THREE from "three/webgpu";
import {
  acesFilmicToneMapping,
  agxToneMapping,
  cineonToneMapping,
  dot,
  float,
  Fn,
  If,
  length,
  linearToneMapping,
  luminance,
  max,
  mix,
  mrt,
  neutralToneMapping,
  output,
  pass,
  pow,
  reinhardToneMapping,
  renderOutput,
  saturate,
  screenSize,
  screenUV,
  smoothstep,
  sRGBTransferOETF,
  step,
  vec2,
  vec3,
  uniform,
  vec4,
} from "three/tsl";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";

// Renders the scene: only what the bolts' materials flag blooms. The flag
// rides in the scene colour's alpha, unused otherwise, rather than a target
// of its own: opaque surfaces and the background write 1, the bolts 0, so
// the mask is its inverse. Tone mapping is done here: one of TONE_MAPPINGS
// for the normal range, with what lies above 1 added back on top so bright
// highlights reach HDR displays. On an HDR canvas all of it is kept, and
// the bolts and sparks (whatever blooms) get hdrBoost times their brightest
// channel on top again, tinted HDR_CORE: an orange, white-hot core inside
// their red glow. hdrBoost is a setting, changed live. The glow also
// counts GLOW_PER_BOOST times hdrBoost over there, so its brighter
// fall-off rises past white with the cores, while the rest of the scene
// stays as it is.
// On a Display P3 canvas the scene is taken into P3, so it looks the same,
// except for what blooms: its colours are read as P3 ones as they are, so
// the bolts' red and their orange cores go deeper than sRGB can show
export const TONE_MAPPINGS = {
  "ACES Filmic": acesFilmicToneMapping,
  AgX: agxToneMapping,
  Neutral: neutralToneMapping,
  Reinhard: reinhardToneMapping,
  Cineon: cineonToneMapping,
  // None: clips at white
  Linear: linearToneMapping,
};
const GLOW_PER_BOOST = 0.15;
export const hdrBoost = uniform(8.0);
// 0 in colour to 1 black and white, of the finished image (game over)
export const greyscale = uniform(0.0);

// Shockwaves where something blew apart: a ring that pushes the image
// outwards, growing to SHOCKWAVE_RADIUS (of the screen's height) and fading
// over SHOCKWAVE_TIME. Each is its screen position (uv) and progress, 0 to
// 1, or below 0 for none
const MAX_SHOCKWAVES = 4;
const SHOCKWAVE_TIME = 0.25; // seconds, as long as the burst
const SHOCKWAVE_RADIUS = 0.14;
const SHOCKWAVE_WIDTH = 0.035;
const SHOCKWAVE_PUSH = 0.02;
const shockwaves = Array.from({ length: MAX_SHOCKWAVES }, () => uniform(new THREE.Vector4(0, 0, -1, 0)));
// How many are on: none, and the pass skips them altogether
const shockwaveCount = uniform(0, "int");
const onScreen = new THREE.Vector3();

// From bursts' world positions and seconds since each began
export function updateShockwaves(camera: THREE.Camera, bursts: Iterable<{ position: THREE.Vector3; time: number }>) {
  let count = 0;
  for (const { position, time } of bursts) {
    if (count === MAX_SHOCKWAVES || time > SHOCKWAVE_TIME) continue;
    onScreen.copy(position).project(camera);
    shockwaves[count++].value.set((onScreen.x + 1) / 2, (1 - onScreen.y) / 2, time / SHOCKWAVE_TIME, 0);
  }
  shockwaveCount.value = count;
  for (; count < MAX_SHOCKWAVES; count++) shockwaves[count].value.z = -1;
}
const HDR_CORE = [1.0, 0.4, 0.12] as const;
// Linear sRGB to linear Display P3, by rows
const SRGB_TO_P3 = [
  [0.8224621, 0.177538, 0.0],
  [0.0331941, 0.9668058, 0.0],
  [0.0170827, 0.0723974, 0.9105199],
] as const;
// Per canvas: glow strength and spread (0 to 1), and how much of what lies
// above white is kept. More of all on an HDR one, which has room for it
const SDR_LOOK = { bloom: 2.0, radius: 0.6, keep: 0.6 };
const HDR_LOOK = { bloom: 3.0, radius: 0.8, keep: 1.0 };
// Final night grade, before tone mapping. Most colour drains to a blue
// monochrome (SATURATION 1 keeps the colours as rendered, 0 is all tint),
// then contrast steepens around a mid grey and exposure darkens it
const SATURATION = 0.66;
const TINT = [0.83, 0.93, 1.29] as const;
const CONTRAST = 1.09;
const CONTRAST_PIVOT = 0.18;
const EXPOSURE = 0.97;

export type PostOptions = {
  // Multisampled here if at all: the scene is the only pass with edges
  msaa: boolean;
  // The canvas takes values past white, or shows Display P3 (see main)
  hdr: boolean;
  p3: boolean;
  // A TONE_MAPPINGS name, ACES Filmic if unknown
  toneMapping: string;
};

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  { msaa, hdr: hdrOutput, p3, toneMapping }: PostOptions
) {
  const look = hdrOutput ? HDR_LOOK : SDR_LOOK;
  const boost = hdrOutput ? hdrBoost : float(0.0);
  // Nothing reads the multisampled colour or depth once the pass has
  // resolved, so they're dropped rather than written out: a sixth of the
  // frame at 2x
  const scenePass = pass(scene, camera, {
    samples: msaa ? 4 : 0,
    storeMultisampledColorBuffer: false,
    storeMultisampledDepthBuffer: false,
  });
  // Materials (the bolts') merge their own outputs into this
  scenePass.setMRT(mrt({ output }));
  // The scene, as the shockwaves push it about
  const aspect = vec2(screenSize.x.div(screenSize.y), 1.0);
  const push = Fn(() => {
    const sum = vec2(0.0).toVar();
    If(shockwaveCount.greaterThan(0), () => {
      for (const wave of shockwaves) {
        const away = screenUV.sub(wave.xy).mul(aspect);
        const distance = length(away);
        const ring = smoothstep(SHOCKWAVE_WIDTH, 0.0, distance.sub(wave.z.mul(SHOCKWAVE_RADIUS)).abs())
          .mul(wave.z.oneMinus())
          .mul(step(0.0, wave.z));
        sum.addAssign(away.div(max(distance, 1e-4)).mul(ring.mul(SHOCKWAVE_PUSH)).div(aspect));
      }
    });
    return sum;
  })();
  const color = scenePass.getTextureNode().sample(screenUV.sub(push));
  const mask = saturate(color.a.oneMinus());
  const glow = bloom(
    color.mul(mask),
    look.bloom,
    look.radius,
    0.0
  );
  // Quarter resolution (default half): the glow is soft anyway, and this
  // makes every blur step about 4x cheaper
  glow.setResolutionScale(0.25);
  // Grade everything but the bolts, so they stay pure red
  const rgb = color.rgb;
  const [r, g, b] = SRGB_TO_P3.map((row) => dot(rgb, vec3(...row)));
  const base = p3 ? mix(vec3(r, g, b), rgb, mask) : rgb;
  const blue = vec3(luminance(base)).mul(vec3(...TINT));
  const toned = mix(blue, base, SATURATION);
  const contrasted = pow(max(toned, 0.0).div(CONTRAST_PIVOT), vec3(CONTRAST))
    .mul(CONTRAST_PIVOT * EXPOSURE);
  const hdr = mix(contrasted, base, mask).add(glow.rgb);
  const curve = TONE_MAPPINGS[toneMapping as keyof typeof TONE_MAPPINGS] ?? acesFilmicToneMapping;
  const filmic = curve(hdr, float(1.0)) as THREE.Node<"vec3">;
  const over = max(hdr.add(glow.rgb.mul(boost.mul(GLOW_PER_BOOST))).sub(1.0), 0.0);
  const whiteHot = vec3(max(base.r, max(base.g, base.b))).mul(mask).mul(vec3(...HDR_CORE));
  const highlights = over.mul(look.keep).add(whiteHot.mul(boost));

  const final = filmic.add(highlights);

  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = renderOutput(
    vec4(sRGBTransferOETF(mix(final, vec3(luminance(final)), greyscale)) as THREE.Node<"vec3">, 1.0),
    THREE.NoToneMapping,
    THREE.LinearSRGBColorSpace
  );
  return pipeline;
}

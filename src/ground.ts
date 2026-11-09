import * as THREE from "three/webgpu";
import {
  dFdx,
  dFdy,
  Fn,
  If,
  mat3,
  max,
  mix,
  normalMap,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import { noise } from "./tslNoise";
import { raindrops } from "./rain";
import { paths } from "./worldMap";

// Brown Mud 03 by Rob Tuytel, Poly Haven (CC0). Scanned at 1.3 m, drawn
// larger so the cracks read at iso distance
const GRAVEL_TILE = 8;

const GRAVEL_URLS = [
  `${import.meta.env.BASE_URL}textures/brown_mud_03_diff_512.webp`,
  `${import.meta.env.BASE_URL}textures/brown_mud_03_nor_gl_512.webp`,
  // Packed ambient occlusion, roughness, metalness
  `${import.meta.env.BASE_URL}textures/brown_mud_03_arm_512.webp`,
];

function tiling(map: THREE.Texture, colorSpace: string) {
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = colorSpace;
  map.anisotropy = 8;
  map.needsUpdate = true;
  return map;
}

// Ground plane that travels with the player, so the field never ends.
// Shows gravel where the world map has paths. Set light to the sun or
// moon's colour, and time every frame
export async function createGround() {
  const light = uniform(new THREE.Color());
  const time = uniform(0);
  const loader = new THREE.TextureLoader();
  const [gravelColor, gravelNormal, gravelArm] = await Promise.all(
    GRAVEL_URLS.map(async (url, i) => tiling(await loader.loadAsync(url), i ? THREE.NoColorSpace : THREE.SRGBColorSpace))
  );

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 1 });
  const xz = positionWorld.xz;
  // World xz mapped to follow the plane's own uv axes (v runs along -z),
  // so the normal map's tangent frame lines up
  const gravelUv = vec2(xz.x, xz.y.negate()).div(GRAVEL_TILE);
  const path = paths(xz).toVar();
  const bare = path.x;

  // Off the paths the ground is plain dark soil under the grass, so all of
  // the below is only worked out where there's path. Sampled with
  // gradients taken outside that branch: inside it, the GPU can't work out
  // a texture's mip level itself
  const uvDx = dFdx(gravelUv);
  const uvDy = dFdy(gravelUv);
  const soil = vec3(...new THREE.Color("#232712").toArray());
  // Colour; occlusion, roughness and how much puddle; and the normal map
  const look = Fn(() => {
    const result = mat3(soil, vec3(1.0, 1.0, 0.0), vec3(0.5, 0.5, 1.0)).toVar();
    If(bare.greaterThan(0.0), () => {
      const arm = texture(gravelArm, gravelUv).grad(uvDx, uvDy);
      const occlusion = mix(1.0, arm.r, bare);

      // Random dark spots break up the flat dirt: damp blotches around
      // half a metre across, and small specks like pebble shadows
      const blotches = smoothstep(0.55, 0.75, noise(xz.mul(1.4).add(17.0)));
      const specks = smoothstep(0.7, 0.85, noise(xz.mul(9.0)));
      const spots = mix(1.0, 0.5, blotches).mul(mix(1.0, 0.6, specks));

      // Puddles in the middle of paths, ringed by darker wet dirt
      const puddleNoise = noise(xz.mul(0.45).add(vec2(-31.0, 8.0)));
      const deepEnough = smoothstep(0.35, 0.6, path.y);
      const puddle = smoothstep(0.65, 0.7, puddleNoise).mul(deepEnough);
      const wet = smoothstep(0.56, 0.68, puddleNoise).mul(deepEnough);

      // Broad light and dark patches hide the tiling
      const gravel = texture(gravelColor, gravelUv)
        .grad(uvDx, uvDy)
        .rgb.mul(noise(xz.mul(0.15)).mul(0.3).add(0.85))
        .mul(spots)
        .mul(mix(1.0, 0.55, wet));
      // Fake shadow from the grass: the path darkens towards its edges
      const grassShadow = mix(0.2, 1.0, path.y);
      // Occlusion also goes into the colour at half strength, since
      // ambient light alone (the only light aoNode affects) is too weak to
      // make the cracks read. Puddles are black smooth metal, so only sun
      // glints and the raindrop rings show on them
      const dirt = mix(soil, gravel.mul(grassShadow), bare).mul(mix(1.0, occlusion, 0.5));
      const roughness = mix(mix(1.0, arm.g, bare), 0.05, max(puddle, wet.mul(0.5)));
      result.assign(
        mat3(
          mix(dirt, vec3(0.0), puddle),
          vec3(occlusion, roughness, puddle),
          texture(gravelNormal, gravelUv).grad(uvDx, uvDy).rgb
        )
      );
    });
    return result;
  })();
  // Its columns (TSL's typings don't know matrices have them)
  const column = (i: number) => (look as unknown as { element(i: number): THREE.Node<"vec3"> }).element(i);
  const surface = column(1);
  const puddle = surface.z;

  mat.colorNode = column(0);
  mat.aoNode = surface.x;
  mat.metalnessNode = puddle;
  mat.roughnessNode = surface.y;
  // Raindrop rings catch the moon/sunlight. Only worked out on puddles,
  // the rest of the ground skips them
  mat.emissiveNode = Fn(() => {
    const rings = vec3(0.0).toVar();
    If(puddle.greaterThan(0.0), () => {
      rings.assign(light.mul(raindrops(xz, time).mul(0.45)).mul(puddle));
    });
    return rings;
  })();
  // Doubled normal strength so the relief reads from the iso distance;
  // water lies flat
  mat.normalNode = normalMap(column(2), vec2(bare.mul(2.0).mul(puddle.oneMinus())));
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), mat);
  mesh.rotation.x = -Math.PI / 2;
  return { mesh, light, time };
}

import * as THREE from "three/webgpu";
import {
  Fn,
  instancedArray,
  instanceIndex,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  fract,
  floor,
  dot,
  mix,
  sin,
  cos,
  abs,
  clamp,
  pow,
  step,
  smoothstep,
  length,
  max,
  normalize,
  uv,
  positionGeometry,
  transformNormalToView,
  faceDirection,
  varying,
  select,
  int,
  saturate,
  uniformArray,
  If,
  ivec2,
  uint,
  Loop,
  positionViewDirection,
  pow2,
  pow3,
  inverseSqrt,
} from "three/tsl";
import { ISO_ELEVATION, ISO_OFFSET, ISO_RIGHT, ISO_UP } from "./iso";
import { hash12, hash22, noise } from "./tslNoise";
import { paths } from "./worldMap";
import { MAX_STAINS, type Stains } from "./stains";

// Trail map resolution (cells per side), the world size it wraps over (so
// it holds trails within half that of the player) and the stamp radius
const TRAIL_RES = 512;
const TRAIL_SIZE = 80;
const TRAIL_TEXEL = TRAIL_SIZE / TRAIL_RES;
// How wide a foot moving through the grass pushes it over, and how hard at
// its centre: the player's and the enemies'
const FOOT_RADIUS = 1.0;
const FOOT_STRENGTH = 0.95;
// How hard blood pushes the blades it lands on, away from the impact: less
// than a footstep
const STAIN_PUSH = 0.7;
// Square of cells painted around a stain, centred this far along its throw:
// enough for its furthest droplets either way (metres)
const STAIN_PAINT_SIZE = 22;
const STAIN_PAINT_AHEAD = 6.5;
const STAIN_CELLS = Math.ceil(STAIN_PAINT_SIZE / TRAIL_TEXEL);
// Most feet in the grass at once: the player and the enemies
const MAX_FEET = 6;
// Furthest a foot is taken to have moved in a frame (metres); further, and
// it's stamped only where it is, so a jump doesn't streak across the field
const MAX_STRIDE = 1;
// Square of cells stamped around each foot: its reach either way of the
// middle of its stride
const FOOT_CELLS = Math.ceil((2 * FOOT_RADIUS + MAX_STRIDE) / TRAIL_TEXEL);
// Where unused foot slots sit, far from any grass
const NOWHERE = 1e6;
// Reach of a stain slot with nothing to paint
const NOT_PAINTING = -1e3;
// Most point lights the grass lights itself with (the bolts' are 14)
const MAX_GRASS_LIGHTS = 16;

// Bolt wakes: the air a bolt's heat sucks in behind it, worked out per
// blade from the bolt's path and how long ago it passed, so nothing is
// kept from frame to frame. It's drawn into pockets strung along the
// bolt's line, a little uneven, that stream on after the bolt, each
// pulling the blades around it in and along the way the bolt went, so the
// line breaks up into soft swirls trailing the bolt rather than one long
// furrow. Most wakes at once, how long each lasts after the bolt passed,
// dying down from the moment it did (seconds), how hard it pulls, how far
// apart its pockets are and how far each reaches (metres), how fast they
// stream after the bolt (metres per second), and how much of the pull is
// along after it rather than in towards the pocket
const MAX_WAKES = 16;
const WAKE_LIFE = 0.9;
const SUCTION = 0.6;
const SUCTION_SPACING = 3;
const SUCTION_RADIUS = 3;
const SUCTION_DRIFT = 4;
const SUCTION_FOLLOW = 0.7;

// A bolt's wake: where it was fired from and the way it flew (on the
// ground), how fast, how far its front got, and seconds since it was
// fired, which the grass counts up. Its pockets are placed by where it was
// fired from, so each wake's are its own
export type Wake = {
  origin: THREE.Vector2;
  direction: THREE.Vector2;
  speed: number;
  reach: number;
  age: number;
};

// Blades lean past the edges of their footprint by up to this much: wind
// (~1.4 m at full gust on soft blades), trail push (up to FOOT_STRENGTH m) and rest bend
const BEND_MARGIN = 3.0;

// The view's ground axes, and the ground direction towards the camera
const viewRight = vec2(...ISO_RIGHT);
const viewUp = vec2(...ISO_UP);
const towardCamera = viewUp.negate();
// World direction towards the camera
const toCamera = vec3(...ISO_OFFSET).normalize();

// Face normal of a bent blade at height uvY: the cross of its x axis with
// the tangent up the blade (the derivative of the bent position with
// respect to uv.y)
function bladeNormal(
  axis: THREE.Node<"vec2">,
  restBend: THREE.Node<"vec2">,
  linearBend: THREE.Node<"vec2">,
  droop: THREE.Node<"float">,
  height: THREE.Node<"float">,
  uvY: THREE.Node<"float">
) {
  const tangentXZ = restBend.mul(uvY.mul(2.0)).add(linearBend);
  const tangentY = height
    .mul(0.6)
    .sub(dot(restBend, restBend).mul(pow(uvY, 4.0)))
    .sub(droop.mul(3.0).mul(uvY.mul(uvY)));
  return normalize(
    vec3(
      axis.y.mul(tangentY).negate(),
      axis.y.mul(tangentXZ.x).sub(axis.x.mul(tangentXZ.y)),
      axis.x.mul(tangentY)
    )
  );
}

function createBladeGeometry(bladeCount: number) {
  const width = 0.1;
  const height = 0.6;

  const yPositions = [0.0, 0.6, 0.8, 1.0];

  const vertices = [];
  const uvs = [];
  const indices = [];

  // Create vertices - all levels except tip have 2 vertices
  for (let y = 0; y < yPositions.length - 1; y++) {
    const v = yPositions[y];
    const taper = 1.0 - v * v * 0.9;

    vertices.push(-width * 0.5 * taper, v * height, 0);
    vertices.push(width * 0.5 * taper, v * height, 0);

    uvs.push(0, v);
    uvs.push(1, v);
  }

  // Add single tip vertex
  const tipV = yPositions[yPositions.length - 1];
  vertices.push(0, tipV * height, 0);
  uvs.push(0.5, tipV);

  // Create indices - quads for body, triangle for tip
  for (let y = 0; y < yPositions.length - 2; y++) {
    const base = y * 2;
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base + 3, base + 2);
  }

  const lastQuadBase = (yPositions.length - 2) * 2;
  indices.push(lastQuadBase, lastQuadBase + 1, lastQuadBase + 2);

  // Instanced geometry without per-instance attributes: per-blade data lives
  // in storage buffers indexed by instanceIndex, so no instanceMatrix needed
  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.instanceCount = bladeCount;

  return geom;
}

// The trail and blood maps, the only grass state kept from frame to frame,
// so they outlive rebuilds.
// The trail map wraps around the world, so it covers the player wherever
// it goes: each cell holds the xz push vector (bend direction scaled by
// strength) that blades rooted there get, when it was pushed, so the
// blades recover with an ease-out from then without the map being visited
// every frame, and the id of the world tile it currently covers, so cells
// reused for a new tile read as empty.
// The blood map is over the same cells: how bloody, and the tile id
function createMaps() {
  const trailMap = instancedArray(TRAIL_RES * TRAIL_RES, "vec4");
  const bloodMap = instancedArray(TRAIL_RES * TRAIL_RES, "vec2");
  // Empty: no tile has the id NOWHERE
  const blood = bloodMap.value.array;
  for (let i = 1; i < blood.length; i += 2) blood[i] = NOWHERE;
  return { trailMap, bloodMap };
}

// With bladeLit, the grass lights itself instead of using three's lights:
// the point lights once per blade, at its root and tip, in the update
// compute, and the sun and ambient light per pixel. Only the chosen path
// is built into the shaders
// A uniform array of vectors, keeping hold of them typed to change later
function vec4Array(vectors: THREE.Vector4[]) {
  return Object.assign(uniformArray<"vec4">(vectors, "vec4"), { array: vectors });
}

function createGrass(
  bladeCount: number,
  stains: Stains,
  bladeLit: boolean,
  boltWakes: boolean,
  { trailMap, bloodMap }: ReturnType<typeof createMaps>
) {
  const uniforms = {
    time: uniform(0),
    // Bottom-left cell of the slot grid in the view's ground grid, its
    // width in slots and the cell size
    gridOrigin: uniform(new THREE.Vector2()),
    gridWidth: uniform(1),
    cellSize: uniform(0.13),
    windSpeed: uniform(1),
    grassHeight: uniform(1.3),
    playerPosition: uniform(new THREE.Vector3(0, 1, 0)),
    // Each foot's path this frame: last frame's xz then this frame's
    feet: vec4Array(Array.from({ length: MAX_FEET }, () => new THREE.Vector4().setScalar(NOWHERE))),
    // Bolt wakes: each wake's origin and direction, then its age, reach,
    // speed, and a seed for where its pockets go
    wakeCount: uniform(0, "int"),
    wakePaths: vec4Array(Array.from({ length: MAX_WAKES }, () => new THREE.Vector4())),
    wakeTimes: vec4Array(Array.from({ length: MAX_WAKES }, () => new THREE.Vector4())),
    // How much of a push's life fades per second
    trailFade: uniform(0),
    tipTint: uniform(new THREE.Vector3(1.0, 0.9, 0.6)),
    wetness: uniform(0),
    specular: uniform(new THREE.Color(0x000000)),
    shininess: uniform(30),
    // The scene's lights, mirrored for bladeLit: colours scaled by
    // intensity, the sun's direction in view space, and each point light's
    // position and range, colour and decay
    ambient: uniform(new THREE.Color(0x000000)),
    sunColor: uniform(new THREE.Color(0x000000)),
    sunView: uniform(new THREE.Vector3(0, 1, 0)),
    lightCount: uniform(0, "int"),
    lightPositions: vec4Array(Array.from({ length: MAX_GRASS_LIGHTS }, () => new THREE.Vector4())),
    lightColors: vec4Array(Array.from({ length: MAX_GRASS_LIGHTS }, () => new THREE.Vector4())),
    // Blood splats spreading this frame: x, z, radius, throw angle (the
    // Stains' own vectors), and how far each has spread, or NOT_PAINTING
    stains: vec4Array(stains.spots),
    stainReach: uniformArray<"float">(new Array<number>(MAX_STAINS).fill(NOT_PAINTING), "float"),
  };

  // Uniform arrays only upload once per render by default, after this
  // frame's compute has already run on stale values; these must upload on
  // every dispatch
  for (const array of [
    uniforms.feet,
    uniforms.stains,
    uniforms.stainReach,
    uniforms.lightPositions,
    uniforms.lightColors,
    uniforms.wakePaths,
    uniforms.wakeTimes,
  ]) {
    array.updateType = THREE.NodeUpdateType.OBJECT;
  }

  const tileId = (tile: THREE.Node<"vec2">) => tile.x.mul(4096.0).add(tile.y);
  // A world cell's (unwrapped) index in the maps, and its tile
  const wrapCell = (c: THREE.Node<"vec2">) => {
    const tile = floor(c.div(TRAIL_RES));
    const wrapped = c.sub(tile.mul(TRAIL_RES));
    return { index: int(wrapped.y).mul(TRAIL_RES).add(int(wrapped.x)), tile };
  };

  // The push a trail cell gives now, or none if it holds another tile: its
  // life runs out over the recovery time from when it was pushed, and the
  // blades spring up fast, then settle gently into rest
  const trailPush = (index: THREE.Node<"int">, id: THREE.Node<"float">) => {
    const trail = trailMap.element(index);
    const life = saturate(uniforms.time.sub(trail.z).mul(uniforms.trailFade).oneMinus());
    return select(trail.w.equal(id), trail.xy.mul(life.mul(life)), vec2(0.0));
  };
  // Pushes a trail cell's blades over, unless they're already pushed
  // harder, so a new push never weakens a trail
  const pushTrail = (index: THREE.Node<"int">, id: THREE.Node<"float">, push: THREE.Node<"vec2">) => {
    const current = trailPush(index, id);
    If(dot(push, push).greaterThan(dot(current, current)), () => {
      trailMap.element(index).assign(vec4(push, uniforms.time, id));
    });
  };

  // Footprints: a capsule from each foot's last frame position to this
  // frame's, so fast movement leaves a continuous trail, stamped over a
  // square of cells around it
  const FOOT_AREA = FOOT_CELLS * FOOT_CELLS;
  const stampFeet = Fn(() => {
    const path = uniforms.feet.element(instanceIndex.div(FOOT_AREA));
    If(path.x.lessThan(NOWHERE / 2), () => {
      const local = instanceIndex.mod(FOOT_AREA);
      const c = floor(path.xy.add(path.zw).mul(0.5).div(TRAIL_TEXEL))
        .sub(FOOT_CELLS / 2)
        .add(vec2(float(local.mod(FOOT_CELLS)), float(local.div(FOOT_CELLS))))
        .toVar();
      const pos = c.add(0.5).mul(TRAIL_TEXEL);
      const segment = path.zw.sub(path.xy);
      const t = clamp(dot(pos.sub(path.xy), segment).div(max(dot(segment, segment), 1e-6)), 0.0, 1.0);
      const toCell = pos.sub(path.xy.add(segment.mul(t))).toVar();
      const distance = length(toCell);
      const strength = smoothstep(0.0, 1.0, float(1.0).sub(distance.div(FOOT_RADIUS))).mul(FOOT_STRENGTH);
      const { index, tile } = wrapCell(c);
      pushTrail(index, tileId(tile), toCell.div(max(distance, 0.001)).mul(strength));
    });
  })().compute(MAX_FEET * FOOT_AREA);

  // Blood: a cone sprayed out from the splat the way the bolt was going,
  // solid near its start and breaking up towards its ragged far end, with
  // droplets flung on past it. Painted into the blood map, over a square
  // around each stain, only while stains spread; the strongest stays
  const STAIN_AREA = STAIN_CELLS * STAIN_CELLS;
  const paintStains = Fn(() => {
    const slot = instanceIndex.div(STAIN_AREA);
    const stain = uniforms.stains.element(slot);
    const reach = uniforms.stainReach.element(slot);
    If(reach.greaterThan(NOT_PAINTING / 2), () => {
      const throwDir = vec2(cos(stain.w), sin(stain.w));
      const local = instanceIndex.mod(STAIN_AREA);
      const c = floor(stain.xy.add(throwDir.mul(STAIN_PAINT_AHEAD)).div(TRAIL_TEXEL))
        .sub(STAIN_CELLS / 2)
        .add(vec2(float(local.mod(STAIN_CELLS)), float(local.div(STAIN_CELLS))))
        .toVar();
      const pos = c.add(0.5).mul(TRAIL_TEXEL);

      // In units of the stain's radius
      const offset = pos.sub(stain.xy).div(stain.z);
      const along = dot(offset, throwDir);
      const across = abs(dot(offset, vec2(throwDir.y.negate(), throwDir.x)));
      const rough = noise(pos.mul(1.6).add(stain.w.mul(17.0))).sub(0.5);
      const halfWidth = along.mul(0.42).add(0.35);
      const inCone = smoothstep(0.12, -0.12, across.sub(halfWidth).add(rough.mul(0.5)))
        .mul(smoothstep(-0.45, -0.15, along))
        .mul(smoothstep(4.3, 3.05, along.add(rough.mul(0.8))));
      // Breaks up into blotches further out
      const solid = smoothstep(along.mul(0.13).sub(0.1), along.mul(0.13).add(0.05), rough.add(0.25));
      const patch = inCone.mul(solid);
      const inFan = smoothstep(0.2, 0.0, across.sub(along.mul(0.5)).sub(0.3));
      const flung = step(0.0, along).mul(inFan).mul(smoothstep(7.0, 2.75, along));
      const droplet = step(hash12(c.add(stain.w.mul(17.0))), flung.mul(0.3));
      // Only as far as it has spread yet, with a ragged front
      const spread = smoothstep(0.0, 0.4, reach.sub(along).add(rough.mul(0.6)));
      const blood = max(patch, droplet).mul(spread).toVar();

      const { index, tile } = wrapCell(c);
      const id = tileId(tile).toVar();
      const cell = bloodMap.element(index);
      const current = select(cell.y.equal(id), cell.x, 0.0);
      If(blood.greaterThan(current).or(cell.y.notEqual(id)), () => {
        cell.assign(vec2(max(blood, current), id));
      });

      // The blades it lands on pushed over away from the impact, by how
      // bloody they are
      const away = pos.sub(stain.xy);
      pushTrail(index, id, away.div(max(length(away), 0.001)).mul(blood.mul(STAIN_PUSH)));
    });
  })().compute(MAX_STAINS * STAIN_AREA);

  // Bilinear sample of the trail push at a world xz position
  const sampleTrail = Fn(([pos]: [THREE.Node<"vec2">]) => {
    const coord = pos.div(TRAIL_TEXEL).sub(0.5);
    const f = fract(coord);
    const c0 = floor(coord);
    // Unwrapped cell -> push, or none if the cell holds another tile
    const at = (c: THREE.Node<"vec2">) => {
      const { index, tile } = wrapCell(c);
      return trailPush(index, tileId(tile));
    };
    return mix(
      mix(at(c0), at(c0.add(vec2(1.0, 0.0))), f.x),
      mix(at(c0.add(vec2(0.0, 1.0))), at(c0.add(vec2(1.0, 1.0))), f.x),
      f.y
    );
  });

  // How the bolts' wakes pull a blade rooted at a world xz position: in
  // towards the two pockets either side of it along each bolt's line and
  // on after the bolt, each pocket a little off its even spacing and of its
  // own strength, streaming after the bolt, strongest the moment it passed
  // and dying away. Only along the stretch the bolt flew, from when its
  // front passed, and within a pocket's reach of its line
  const wakePush = Fn(([pos]: [THREE.Node<"vec2">]) => {
    const push = vec2(0.0).toVar();
    Loop(uniforms.wakeCount, ({ i }) => {
      const path = uniforms.wakePaths.element(i);
      const times = uniforms.wakeTimes.element(i);
      const offset = pos.sub(path.xy);
      const side = vec2(path.w.negate(), path.z);
      const along = dot(offset, path.zw).toVar();
      const across = dot(offset, side).toVar();
      const age = times.x.sub(along.div(times.z)).toVar();
      If(
        along
          .greaterThan(0.0)
          .and(along.lessThan(times.y))
          .and(age.greaterThan(0.0))
          .and(age.lessThan(WAKE_LIFE))
          .and(abs(across).lessThan(SUCTION_RADIUS)),
        () => {
          const drift = age.mul(SUCTION_DRIFT).toVar();
          const first = floor(along.sub(drift).div(SUCTION_SPACING).sub(0.5)).toVar();
          const inwards = vec2(0.0).toVar();
          const total = float(0.0).toVar();
          for (const next of [0, 1]) {
            const pocket = first.add(next);
            const vary = hash22(vec2(pocket, times.w));
            const middle = pocket.add(0.5).add(vary.x.sub(0.5).mul(0.6)).mul(SUCTION_SPACING).add(drift);
            const toMiddle = path.zw.mul(middle.sub(along)).sub(side.mul(across)).toVar();
            const squared = dot(toMiddle, toMiddle).toVar();
            const pull = pow2(saturate(squared.div(SUCTION_RADIUS * SUCTION_RADIUS).oneMinus()))
              .mul(vary.y.mul(0.4).add(0.6))
              .toVar();
            // Eased into the middle, so the blades there don't flip
            inwards.addAssign(toMiddle.mul(inverseSqrt(max(squared, 0.16))).mul(pull));
            total.addAssign(pull);
          }
          const strength = pow3(age.div(WAKE_LIFE).oneMinus()).mul(SUCTION);
          push.addAssign(inwards.mul(1 - SUCTION_FOLLOW).add(path.zw.mul(total.mul(SUCTION_FOLLOW))).mul(strength));
        }
      );
    });
    return push;
  });

  // Per-frame per-blade data, packed for the vertex shader (3 vec4 per vertex)
  const bladeXform = instancedArray(bladeCount, "vec4"); // posX, posZ, scaled blade x axis
  const bladeBend = instancedArray(bladeCount, "vec4"); // linear bend.xz, cubic droop, height
  const bladeLook = instancedArray(bladeCount, "vec4"); // restBend.xz, colorVar + dryness, shade + blood
  // Point light irradiance at the root and tip, and the specular highlight
  // it makes as a fraction of it (bladeLit only)
  const bladeLightRoot = bladeLit ? instancedArray(bladeCount, "vec4") : null;
  const bladeLightTip = bladeLit ? instancedArray(bladeCount, "vec4") : null;

  // Light from the point lights reaching a world position on a surface
  // facing n, as three works it out (inverse power falloff, eased to zero
  // at the light's range). Its Blinn-Phong highlight goes in w, as a
  // fraction of the light: the fraction of a single light's, and close
  // enough for a few lights of similar colour. Fresnel's brightening at
  // grazing angles is left out
  const pointLight = Fn(([position, n]: [THREE.Node<"vec3">, THREE.Node<"vec3">]) => {
    const sum = vec3(0.0).toVar();
    const highlights = float(0.0).toVar();
    const brightness = float(0.0).toVar();
    Loop(uniforms.lightCount, ({ i }) => {
      const light = uniforms.lightPositions.element(i);
      const color = uniforms.lightColors.element(i);
      const toLight = light.xyz.sub(position);
      const distance = length(toLight).toVar();
      // Out of the light's range it adds nothing: skipped
      If(distance.lessThan(light.w), () => {
        const falloff = pow(distance, color.w)
          .max(0.01)
          .reciprocal()
          .mul(pow(saturate(pow(distance.div(light.w), 4.0).oneMinus()), 2.0));
        const direction = toLight.div(distance).toVar();
        const irradiance = color.xyz.mul(saturate(dot(n, direction)).mul(falloff)).toVar();
        sum.addAssign(irradiance);

        const half = direction.add(toCamera).normalize();
        const dotVH = saturate(dot(toCamera, half));
        const fresnel = dotVH.mul(-5.55473).sub(6.98316).mul(dotVH).exp2();
        const highlight = uniforms.shininess
          .mul(0.5)
          .add(1.0)
          .mul(0.25 / Math.PI)
          .mul(pow(saturate(dot(n, half)), uniforms.shininess))
          .mul(fresnel.oneMinus());
        const amount = irradiance.x.add(irradiance.y).add(irradiance.z);
        highlights.addAssign(highlight.mul(amount));
        brightness.addAssign(amount);
      });
    });
    return vec4(sum, highlights.div(brightness.max(1e-6)));
  });

  // Everything that only depends on the blade (not the vertex) is computed
  // once per blade here, instead of once per vertex in the vertex shader
  const update = Fn(() => {
    // Each slot covers one cell of a world-locked grid along the view's
    // ground axes. The slot grid follows the camera, and every blade
    // property hashes from the cell, so blades stay put as it scrolls. The
    // cell is worked out in integers: in floats, the GPU's fast maths can
    // round a cell's values a hair differently from slot to slot, which
    // flips blades sitting right at a path's cull threshold as they move
    // between slots
    const width = uint(uniforms.gridWidth);
    const slot = ivec2(int(instanceIndex.mod(width)), int(instanceIndex.div(width)));
    const cell = vec2(ivec2(uniforms.gridOrigin).add(slot)).toVar();
    const local = cell.add(hash22(cell)).mul(uniforms.cellSize);
    const grassPos = viewRight.mul(local.x).add(viewUp.mul(local.y)).toVar();

    // Paths: blades thin out towards bare ground, the survivors shorter and
    // drier; culled blades collapse to zero size
    const bare = paths(grassPos).x.toVar();
    const culled = hash12(cell.add(vec2(-63.7, 29.1))).lessThan(bare);
    const pathScale = select(culled, 0.0, bare.mul(-0.6).add(1.0));

    const sizeVars = hash22(cell.add(vec2(37.1, 11.7)));
    const heightVar = uniforms.grassHeight
      .add(sizeVars.x.mul(0.8))
      .mul(pathScale)
      .toVar();
    const widthVar = sizeVars.y.mul(0.6).add(0.7).mul(select(culled, 0.0, 1.0));
    const motionVars = hash22(cell.add(vec2(-19.3, 53.9)));
    const stiffness = motionVars.x.mul(0.8).add(0.5);
    const randomRotation = motionVars.y.mul(6.28318);
    const cosRot = cos(randomRotation).toVar();
    const sinRot = sin(randomRotation).toVar();

    // Random initial bend - gives blades natural resting position.
    // Pre-scaled by height; vertex applies it with a uv.y^2 curve
    const bendVars = hash22(cell.add(vec2(71.3, -43.1)));
    const bendAngle = bendVars.x.mul(6.28318);
    const restBend = vec2(cos(bendAngle), sin(bendAngle))
      .mul(bendVars.y.mul(0.25))
      .mul(heightVar);

    const colorVar = hash12(cell.add(vec2(5.7, 97.3)));

    // View-space thickening
    const grassFaceNormal = vec2(sinRot.negate(), cosRot);
    const viewDotNormal = clamp(abs(dot(grassFaceNormal, towardCamera)), 0.0, 1.0);
    const thicken = pow(viewDotNormal.oneMinus(), 2.0);

    // Wind system
    const windSpeed = uniforms.windSpeed;
    const windTime = uniforms.time.mul(windSpeed);
    const detailCoord = grassPos
      .mul(0.1)
      .add(vec2(windTime.mul(-0.4), windTime.mul(-0.2)));
    const windDetail = noise(detailCoord).mul(0.4);
    const gustCoord = grassPos
      .mul(0.03)
      .add(vec2(windTime.mul(-0.6), windTime.mul(-0.5)));
    const gustBase = noise(gustCoord).mul(0.4);
    const totalWind = windDetail
      .add(gustBase)
      .mul(windSpeed)
      .div(stiffness)
      .sub(windSpeed.mul(0.5))
      .toVar();

    // Trail from the trail map: push direction and strength, and the
    // bolts' wakes on top, held to a footstep's push
    const trailBend = sampleTrail(grassPos).toVar();
    if (boltWakes) {
      trailBend.addAssign(wakePush(grassPos));
      trailBend.mulAssign(float(FOOT_STRENGTH).div(max(length(trailBend), FOOT_STRENGTH)));
    }

    // Wind and trail both bend linearly with uv.y in xz and droop with uv.y^3
    const linearBend = vec2(totalWind, totalWind.mul(0.3))
      .add(trailBend)
      .toVar();
    const droop = totalWind
      .mul(totalWind)
      .mul(0.1)
      .add(dot(trailBend, trailBend).mul(0.3))
      .toVar();

    // Flattened blades are seen face-on from above, so drop the edge-on
    // thickening or they smear into wide ribbons
    const upright = smoothstep(0.0, 0.8, length(trailBend)).oneMinus();
    const xAxis = vec2(cosRot, sinRot).mul(
      widthVar.add(thicken.mul(4.0).mul(upright)).mul(select(culled, 0.0, 1.0))
    );

    // Blood painted where this blade is rooted or where its tip rests, so
    // blades leaning over a stain take it too. Not where wind or trails
    // bend it, or blades would flicker in and out of the stain
    const bloodAt = (pos: THREE.Node<"vec2">) => {
      const { index, tile } = wrapCell(floor(pos.div(TRAIL_TEXEL)));
      const cell = bloodMap.element(index);
      return select(cell.y.equal(tileId(tile)), cell.x, 0.0);
    };
    const blood = max(bloodAt(grassPos), bloodAt(grassPos.add(restBend)));

    // Shadow under the player
    const distanceToPlayer = length(grassPos.sub(uniforms.playerPosition.xz));
    const shadowStrength = smoothstep(0.0, 2.0, distanceToPlayer).oneMinus().mul(0.8);

    if (bladeLightRoot && bladeLightTip) {
      // Lit on the side the camera sees
      const axis = vec2(cosRot, sinRot);
      const litAt = (uvY: number, position: THREE.Node<"vec3">) => {
        const n = bladeNormal(axis, restBend, linearBend, droop, heightVar, float(uvY)).toVar();
        const seen = n.mul(select(dot(n, toCamera).lessThan(0.0), -1.0, 1.0));
        return pointLight(position, seen);
      };
      const tipXZ = grassPos.add(restBend).add(linearBend);
      const tipY = heightVar.mul(0.6).sub(dot(restBend, restBend).mul(0.2).add(droop));
      bladeLightRoot.element(instanceIndex).assign(litAt(0, vec3(grassPos.x, 0.0, grassPos.y)));
      bladeLightTip.element(instanceIndex).assign(litAt(1, vec3(tipXZ.x, tipY, tipXZ.y)));
    }

    bladeXform.element(instanceIndex).assign(vec4(grassPos, xAxis));
    bladeBend
      .element(instanceIndex)
      .assign(vec4(linearBend, droop, heightVar));
    bladeLook
      .element(instanceIndex)
      .assign(
        // Dryness and blood packed into the integer parts of the colour
        // variation and the shade
        vec4(
          restBend,
          colorVar.mul(0.999).add(floor(bare.mul(15.0))),
          shadowStrength.oneMinus().mul(0.999).add(floor(blood.mul(15.0)))
        )
      );
  })().compute(bladeCount);

  const xform = bladeXform.toAttribute();
  const bend = bladeBend.toAttribute();
  const look = bladeLook.toAttribute();

  const uvY = uv().y;

  const position = Fn(() => {
    const heightVar = bend.w;
    const restBend = look.xy;

    const uvY2 = uvY.mul(uvY);
    const uvY3 = uvY2.mul(uvY);

    // Initial resting bend (uv.y^2 curve) plus wind + trail (linear)
    const offsetXZ = restBend.mul(uvY2).add(bend.xy.mul(uvY));

    // Length compensation for all bends
    const droop = dot(restBend, restBend)
      .mul(0.2)
      .mul(uvY2)
      .add(bend.z)
      .mul(uvY3);

    // Blade geometry lies in the local xy plane, so rotate + scale is one mul
    const xz = xform.xy.add(xform.zw.mul(positionGeometry.x)).add(offsetXZ);
    return vec3(xz.x, positionGeometry.y.mul(heightVar).sub(droop), xz.y);
  })();

  // Lighting modifier with yellow tint at tips - all in vertex
  const color = Fn(() => {
    const colorVar = fract(look.z);
    const dryness = floor(look.z).div(15.0);
    const shade = fract(look.w);
    const blood = floor(look.w).div(15.0);
    const grass = mix(
      vec3(0.12, 0.62, 0.12).add(
        vec3(0.1, 0.3, 0.05).mul(colorVar.sub(0.5).mul(2.0))
      ),
      vec3(0.42, 0.45, 0.14),
      dryness.mul(0.7)
    );
    const tint = mix(grass, vec3(0.42, 0.015, 0.025), blood.mul(0.92));

    const linearModifier = uvY.add(0.1);
    const tipFactor = uvY.sub(0.66).mul(3.0);
    const tipModifier = tipFactor.mul(tipFactor).mul(2.5).add(0.8);
    const lightIntensity = mix(linearModifier, tipModifier, step(0.75, uvY));
    const lightColor = mix(
      vec3(1.0),
      uniforms.tipTint,
      smoothstep(1.0, 1.5, lightIntensity)
    );
    // Wet blades soak up light, going darker
    const wetDarken = mix(1.0, 0.75, uniforms.wetness);
    return tint.mul(shade).mul(lightColor).mul(lightIntensity).mul(wetDarken);
  })();

  const axis = normalize(xform.zw);

  // Face normal follows the bend
  const faceNormal = bladeNormal(axis, look.xy, bend.xy, bend.z, bend.w, uvY);

  // Normal tilts across the blade for a round profile. Done per fragment
  // since the blade has no centre vertices. Flipped for back faces
  const roundTilt = uv().x.sub(0.5).mul(1.5);
  const localNormal = normalize(varying(faceNormal).add(varying(vec3(axis.x, 0.0, axis.y)).mul(roundTilt)));
  const normal = transformNormalToView(localNormal)
    .normalize()
    .mul(faceDirection);

  // Fake AO: speculars strongest at the tips, fading into the dense base.
  // Wet blades shine further down
  const specular = uniforms.specular.mul(smoothstep(uniforms.wetness.mul(-0.6), 1.0, uvY));

  let material: THREE.NodeMaterial;
  if (bladeLightRoot && bladeLightTip) {
    // The same Phong maths three would do. The blade's point light, blended
    // up from root to tip in the vertex shader
    const point = varying(mix(bladeLightRoot.toAttribute(), bladeLightTip.toAttribute(), uvY));
    // The sun per pixel, so it shades across the round blade
    const sunNL = saturate(dot(normal, uniforms.sunView));
    const sunLight = sunNL.mul(uniforms.sunColor);
    const half = uniforms.sunView.add(positionViewDirection).normalize();
    const dotNH = saturate(dot(normal, half));
    const dotVH = saturate(dot(positionViewDirection, half));
    const fresnel = dotVH.mul(-5.55473).sub(6.98316).mul(dotVH).exp2();
    const reflectance = vec3(specular).mul(fresnel.oneMinus()).add(fresnel);
    const highlight = uniforms.shininess
      .mul(0.5)
      .add(1.0)
      .mul(1 / Math.PI)
      .mul(pow(dotNH, uniforms.shininess));
    const diffuse = varying(color)
      .mul(point.xyz.add(sunLight).add(uniforms.ambient))
      .mul(1 / Math.PI);

    const basic = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    basic.lights = false;
    basic.colorNode = diffuse
      .add(sunLight.mul(reflectance).mul(highlight).mul(0.25))
      .add(point.xyz.mul(specular).mul(point.w));
    material = basic;
  } else {
    const phong = new THREE.MeshPhongNodeMaterial({ side: THREE.DoubleSide });
    phong.colorNode = varying(color);
    phong.normalNode = normal;
    phong.specularNode = specular;
    phong.shininessNode = uniforms.shininess;
    material = phong;
  }
  material.positionNode = position;

  const buffers = [bladeXform, bladeBend, bladeLook, bladeLightRoot, bladeLightTip];

  return {
    uniforms,
    stampFeet,
    paintStains,
    update,
    material,
    dispose: () => {
      material.dispose();
      for (const buffer of buffers) buffer?.value.dispose?.();
      for (const compute of [stampFeet, paintStains, update]) compute.dispose();
    },
  };
}

export type GrassLook = {
  specular: string;
  shininess: number;
  // Raw (non color-managed) tint multiplied into bright blade tips
  tipTint: [number, number, number];
  // 0 dry to 1 soaked: darker blades, gloss further down the blade
  wetness: number;
};

const viewDirection = new THREE.Vector3();
const stride = new THREE.Vector2();
const lightColor = new THREE.Color();
const lightPosition = new THREE.Vector3();
const targetPosition = new THREE.Vector3();
const view = new THREE.Frustum();
const viewMatrix = new THREE.Matrix4();
const reach = new THREE.Sphere();
// How far past the screen's edge a light still matters: blades whose root
// is off screen can reach into it (metres)
const OFF_SCREEN_REACH = 3;

// Copies the scene's visible lights into the grass's own: the ambient
// lights summed, one directional light (the sun or moon) and the first
// MAX_GRASS_LIGHTS point lights that can reach the screen
function mirrorLights(
  scene: THREE.Scene,
  camera: THREE.Camera,
  uniforms: ReturnType<typeof createGrass>["uniforms"]
) {
  uniforms.ambient.value.setRGB(0, 0, 0);
  uniforms.sunColor.value.setRGB(0, 0, 0);
  let count = 0;
  view.setFromProjectionMatrix(viewMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  scene.traverseVisible((object) => {
    const light = object as THREE.Light;
    if (!light.isLight) return;
    lightColor.copy(light.color).multiplyScalar(light.intensity);
    if ((light as THREE.AmbientLight).isAmbientLight) {
      uniforms.ambient.value.add(lightColor);
    } else if ((light as THREE.DirectionalLight).isDirectionalLight) {
      const sun = light as THREE.DirectionalLight;
      sun.updateWorldMatrix(true, false);
      sun.target.updateWorldMatrix(true, false);
      lightPosition.setFromMatrixPosition(sun.matrixWorld);
      targetPosition.setFromMatrixPosition(sun.target.matrixWorld);
      uniforms.sunColor.value.copy(lightColor);
      uniforms.sunView.value
        .subVectors(lightPosition, targetPosition)
        .transformDirection(camera.matrixWorldInverse);
    } else if ((light as THREE.PointLight).isPointLight && count < MAX_GRASS_LIGHTS) {
      const point = light as THREE.PointLight;
      point.updateWorldMatrix(true, false);
      lightPosition.setFromMatrixPosition(point.matrixWorld);
      reach.set(lightPosition, point.distance + OFF_SCREEN_REACH);
      if (point.distance && !view.intersectsSphere(reach)) return;
      // A range of 0 means endless
      uniforms.lightPositions.array[count].set(
        lightPosition.x,
        lightPosition.y,
        lightPosition.z,
        point.distance || 1e9
      );
      uniforms.lightColors.array[count].set(lightColor.r, lightColor.g, lightColor.b, point.decay);
      count++;
    }
  });
  uniforms.lightCount.value = count;
}

// Sliders for the field; density (and bladeLit) rebuild it. The field
// always reaches far enough below the screen for blades this tall
export const MAX_BLADE_HEIGHT = 4;
export const grassSettings = {
  density: 55,
  bladeHeight: 2,
  windSpeed: 1.0,
  trailRecovery: 10,
  // Lights the grass itself, point lights once per blade, instead of with
  // three's per pixel lights
  bladeLit: true,
  // Bolts suck the grass in behind them as they pass. Off, they leave it
  // be, and none of it is built into the shaders
  boltWakes: true,
};

// The grass field: a mesh to add to the scene, rebuild() whenever the view's
// size or a rebuilding setting changes, and update() every frame
export function grassField(
  renderer: THREE.WebGPURenderer,
  stains: Stains,
  // Feet that flatten the grass as they move, at most MAX_FEET
  feet: Set<THREE.Vector3>,
  // Wakes the bolts leave, oldest first; the grass ages them and drops them
  // once spent, or straight away with bolt wakes off
  wakes: Set<Wake>,
  // Where the player is, for the shadow under it
  player: THREE.Vector3
) {
  const mesh = new THREE.Mesh();
  mesh.frustumCulled = false;
  // Drawn before the ground it covers, so GPUs that only skip hidden
  // pixels behind what's already drawn (all but Apple's) skip shading the
  // ground beneath. Its slots already run from the camera outwards
  mesh.renderOrder = -1;
  const maps = createMaps();
  let grass: ReturnType<typeof createGrass>;
  let lastFeet = new Map<THREE.Vector3, THREE.Vector2>();
  // Slot grid covering the ground the fixed iso view sees, in the view's
  // ground axes relative to the point at the centre of the screen
  const grid = { cellSize: 1, columns: 0, minRight: 0, minUp: 0 };

  // The view's size in world units, across and up the screen
  function rebuild(viewWidth: number, viewHeight: number) {
    const { density, bladeLit, boltWakes } = grassSettings;
    grid.cellSize = 1 / Math.sqrt(density);
    const width = viewWidth + 2 * BEND_MARGIN;
    const depth = viewHeight / Math.sin(ISO_ELEVATION);
    // Blades rooted below the bottom edge still reach up into view
    const nearMargin = (MAX_BLADE_HEIGHT + 0.8) / Math.tan(ISO_ELEVATION) + BEND_MARGIN;
    grid.columns = Math.ceil(width / grid.cellSize);
    grid.minRight = -width / 2;
    grid.minUp = -depth / 2 - nearMargin;
    const bladeCount = grid.columns * Math.ceil((depth + nearMargin + BEND_MARGIN) / grid.cellSize);

    dispose();
    grass = createGrass(bladeCount, stains, bladeLit, boltWakes, maps);
    mesh.geometry = createBladeGeometry(bladeCount);
    mesh.material = grass.material;
    grass.uniforms.gridWidth.value = grid.columns;
    grass.uniforms.cellSize.value = grid.cellSize;
  }

  function dispose() {
    grass?.dispose();
    mesh.geometry.dispose();
  }

  function update(
    delta: number,
    time: number,
    scene: THREE.Scene,
    camera: THREE.Camera,
    look: GrassLook
  ) {
    const { uniforms } = grass;
    uniforms.time.value = time;
    uniforms.windSpeed.value = grassSettings.windSpeed;
    uniforms.grassHeight.value = grassSettings.bladeHeight;
    uniforms.trailFade.value = 1 / grassSettings.trailRecovery;
    uniforms.specular.value.set(look.specular);
    uniforms.shininess.value = look.shininess;
    uniforms.tipTint.value.fromArray(look.tipTint);
    uniforms.wetness.value = look.wetness;
    uniforms.playerPosition.value.copy(player);
    if (grassSettings.bladeLit) mirrorLights(scene, camera, uniforms);

    // Ground point at the centre of the screen, in view ground axes
    camera.getWorldDirection(viewDirection);
    const t = -camera.position.y / viewDirection.y;
    const centerX = camera.position.x + viewDirection.x * t;
    const centerZ = camera.position.z + viewDirection.z * t;
    const right = centerX * ISO_RIGHT[0] + centerZ * ISO_RIGHT[1];
    const up = centerX * ISO_UP[0] + centerZ * ISO_UP[1];
    uniforms.gridOrigin.value.set(
      Math.floor((right + grid.minRight) / grid.cellSize),
      Math.floor((up + grid.minUp) / grid.cellSize)
    );

    // Each foot's path since last frame; one that just joined starts where
    // it is, so a spawn doesn't streak across the field
    const seen = new Map<THREE.Vector3, THREE.Vector2>();
    let slot = 0;
    for (const position of feet) {
      if (slot === MAX_FEET) break;
      const last = lastFeet.get(position) ?? new THREE.Vector2(position.x, position.z);
      if (last.distanceTo(stride.set(position.x, position.z)) > MAX_STRIDE) last.copy(stride);
      uniforms.feet.array[slot++].set(last.x, last.y, position.x, position.z);
      seen.set(position, last.set(position.x, position.z));
    }
    for (; slot < MAX_FEET; slot++) uniforms.feet.array[slot].setScalar(NOWHERE);
    lastFeet = seen;

    // The newest MAX_WAKES wakes still pulling; with bolt wakes off, none
    let count = 0;
    for (const wake of wakes) {
      wake.age += delta;
      const spent = wake.age > wake.reach / wake.speed + WAKE_LIFE;
      if (spent || wakes.size > MAX_WAKES || !grassSettings.boltWakes) {
        wakes.delete(wake);
        continue;
      }
      uniforms.wakePaths.array[count].set(wake.origin.x, wake.origin.y, wake.direction.x, wake.direction.y);
      uniforms.wakeTimes.array[count++].set(wake.age, wake.reach, wake.speed, wake.origin.x + wake.origin.y * 7.3);
    }
    uniforms.wakeCount.value = count;

    renderer.compute(grass.stampFeet);

    // Stains are painted while they spread as their blood lands
    stains.update(delta);
    let spreading = false;
    stains.spreading.forEach((painting, i) => {
      uniforms.stainReach.array[i] = painting ? stains.reach[i] : NOT_PAINTING;
      spreading ||= painting;
    });
    if (spreading) renderer.compute(grass.paintStains);
    renderer.compute(grass.update);
  }

  // Runs the pass only run when blood lands, painting nothing, so it's
  // compiled before it's needed
  function compilePasses() {
    renderer.compute(grass.paintStains);
  }

  return { mesh, rebuild, update, compilePasses };
}

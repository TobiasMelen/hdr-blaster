import * as THREE from "three/webgpu";
import {
  mrt,
  output,
  vec4,
  normalView,
  pow,
  saturate,
  vec3,
} from "three/tsl";
import { Debris, type DebrisStyle } from "./debris";
import type { Wake } from "./grass";
import type { Stains } from "./stains";

// Red laser bolts, shared by everyone who shoots. Each flies level from
// where it was fired and ends on the first target of another team it
// passes through, or after BOLT_LIFE. A hit blows the target apart: the
// bolt bursts into sparks and a blood mist thrown from along its front, on
// the way it was going, and its light flashes

const BOLT_SPEED = 70; // metres per second
const BOLT_LIFE = 0.7; // seconds
// Each bolt leaves the muzzle as a short fat orb and stretches out into a
// bolt over this long, its tail held at the muzzle until then
const BOLT_GROW = 0.09; // seconds
const ORB_WIDTH = 11; // times the bolt's radius
const ORB_LENGTH = 0.14; // times the bolt's length
const BOLT_LENGTH = 4.4;
const BOLT_RADIUS = 0.035;

// Enough for every bolt that can be alive at once: the player's at full
// rate and the enemies'. Each has its own red point light, hidden while
// idle: clustered lighting doesn't recompile materials when point lights
// come and go, but every light it holds costs on every lit pixel near it
const POOL_SIZE = 14;
const LIGHT_INTENSITY = 32;
const LIGHT_COLOR = "#a0280a";
const LIGHT_RANGE = 14;
// The light flashes this many times brighter as the orb leaves the muzzle,
// dying down as it stretches into a bolt
const MUZZLE_FLASH = 2;

// The burst on a hit: the bolt bursts into its debris, thrown from along
// its front, and its light flashes and dies over BURST_TIME
const BURST_TIME = 0.25; // seconds
const BURST_LIGHT = 380; // light intensity at the flash
const BURST_LIGHT_RANGE = 22;
// Share of the bolt, from its front, that the debris is thrown from
const BURST_ALONG = 0.2;

// Sparks: hot streaks blown on in a cone along the bolt's way, slowing and
// falling
const SPARKS: DebrisStyle = {
  pool: 330,
  perBurst: 70,
  life: [0.3, 0.65],
  speed: [11, 23],
  carry: 2.6,
  fan: 1.9,
  lift: 0.1,
  gravity: 22,
  drag: 1.6,
  width: 0.18,
  stretch: 0.065,
  shrink: 1,
  // From all over the body rather than one line
  body: { radius: 0.3, below: 0.15 },
};

// Opacity at the middle of a blood mist puff
const MIST_OPACITY = 0.26;

// Blood mist: a faint red cloud puffed out of the body, swelling as it
// rolls out the bolt's way over the splatter as that spreads, slowing as
// it goes, and thins out
const MIST: DebrisStyle = {
  pool: 84,
  perBurst: 14,
  life: [0.7, 1.1],
  speed: [8, 16],
  carry: 3,
  fan: 0.7,
  lift: 0.15,
  gravity: 1,
  drag: 2,
  // Starts out big and peaks early, so it bursts in rather than swells
  width: 1.9,
  variety: 0.4,
  stretch: 0,
  shrink: 1,
  grow: 2.5,
  body: { radius: 0.3, below: 0.7 },
};

export type Team = "player" | "enemy";

// Something bolts can hit: an upright cylinder at a ground position. A hit
// blows it apart: the bolt bursts, its blood stains the grass, it stops
// being a target, and hit() is told
export type Target = {
  team: Team;
  position: THREE.Vector3;
  radius: number;
  hit: () => void;
};

type Bolt = {
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  team: Team;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  // Distance of the front end from the origin; once bursting, from the
  // impact
  head: number;
  // Its wake in the grass, from the latest time it was fired: its own, so
  // it pulls on after the bolt is gone or reused
  wake: Wake;
  state: "idle" | "flying" | "bursting";
  time: number; // seconds in that state
};

// A wake not yet anywhere
const newWake = (): Wake => ({
  origin: new THREE.Vector2(),
  direction: new THREE.Vector2(),
  speed: BOLT_SPEED,
  reach: 0,
  age: 0,
});

const yAxis = new THREE.Vector3(0, 1, 0);
const toTarget = new THREE.Vector2();
const impact = new THREE.Vector3();

export class BoltPool {
  readonly group = new THREE.Group();
  readonly targets = new Set<Target>();
  private readonly bolts: Bolt[] = [];
  private readonly geometry = new THREE.CapsuleGeometry(BOLT_RADIUS, BOLT_LENGTH, 4, 8);
  // Unlit, like the mist: neither shades from the scene's lights
  private readonly material = new THREE.MeshBasicNodeMaterial({ lights: false });
  private next = 0;
  private readonly sparkGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly mistGeometry = new THREE.IcosahedronGeometry(0.5, 2);
  // Soft edged: see-through towards its outline, so it reads as a cloud
  private readonly mistMaterial = new THREE.MeshBasicNodeMaterial({
    lights: false,
    color: "#5a0710",
    transparent: true,
    depthWrite: false,
  });
  private readonly mist: Debris;
  private readonly sparks: Debris;

  private readonly stains: Stains;

  private readonly wakes: Set<Wake>;

  constructor(stains: Stains, wakes: Set<Wake>) {
    this.stains = stains;
    this.wakes = wakes;
    // Over-bright so it stays saturated deep red after tone mapping, and
    // flagged for the selective bloom pass by a zero alpha
    this.material.colorNode = vec3(4.5, 0.12, 0.075);
    this.material.mrtNode = mrt({ output: vec4(output.rgb, 0.0) });

    for (let i = 0; i < POOL_SIZE; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_RANGE, 2);
      light.visible = false;

      this.group.add(mesh, light);
      this.bolts.push({
        mesh,
        light,
        team: "player",
        origin: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        head: 0,
        wake: newWake(),
        state: "idle",
        time: 0,
      });
    }

    this.mistMaterial.opacityNode = pow(saturate(normalView.z), 2.0).mul(MIST_OPACITY);

    // Same glowing material, so sparks bloom too
    this.sparks = new Debris(SPARKS, this.sparkGeometry, this.material);
    this.mist = new Debris(MIST, this.mistGeometry, this.mistMaterial);
    this.group.add(this.sparks.mesh, this.mist.mesh);
  }

  // Fire from a muzzle along a level direction, reusing the oldest bolt
  fire(team: Team, muzzle: THREE.Vector3, direction: THREE.Vector3) {
    const bolt = this.bolts[this.next];
    this.next = (this.next + 1) % this.bolts.length;
    bolt.team = team;
    bolt.state = "flying";
    bolt.time = 0;
    bolt.head = 0;
    bolt.light.distance = LIGHT_RANGE;
    bolt.light.visible = true;
    bolt.origin.copy(muzzle);
    bolt.direction.copy(direction).setY(0).normalize();
    bolt.mesh.quaternion.setFromUnitVectors(yAxis, bolt.direction);
    bolt.mesh.visible = true;
    bolt.wake = newWake();
    bolt.wake.origin.set(muzzle.x, muzzle.z);
    bolt.wake.direction.set(bolt.direction.x, bolt.direction.z);
    this.wakes.add(bolt.wake);
  }

  update(delta: number) {
    for (const bolt of this.bolts) {
      if (bolt.state === "bursting") this.updateBurst(bolt, delta);
      if (bolt.state !== "flying") continue;
      bolt.time += delta;
      if (bolt.time >= BOLT_LIFE) {
        this.end(bolt);
        continue;
      }
      const grown = Math.min(bolt.time / BOLT_GROW, 1);
      const ease = 1 - (1 - grown) * (1 - grown);
      const width = THREE.MathUtils.lerp(ORB_WIDTH, 1, ease);
      const length = THREE.MathUtils.lerp(ORB_LENGTH, 1, ease);
      bolt.mesh.scale.set(width, length, width);
      // Tail at the muzzle while growing, then the whole bolt flies on
      const travelled = Math.max(bolt.time - BOLT_GROW, 0) * BOLT_SPEED;
      const head = travelled + BOLT_LENGTH * length;

      // Hits anything of another team the front swept past this frame
      const target = this.sweep(bolt, bolt.head, head);
      if (target) {
        this.stains.add(target.position.x, target.position.z, bolt.direction);
        this.targets.delete(target);
        target.hit();
        this.explode(bolt, target);
        continue;
      }
      bolt.head = head;
      bolt.wake.reach = head;

      bolt.mesh.position
        .copy(bolt.origin)
        .addScaledVector(bolt.direction, travelled + (BOLT_LENGTH * length) / 2);
      bolt.light.position.copy(bolt.mesh.position);
      bolt.light.intensity = LIGHT_INTENSITY * (1 + MUZZLE_FLASH * (1 - ease));
    }
    this.sparks.update(delta);
    this.mist.update(delta);
  }

  // Burst the bolt where its front met the target: gone, its debris thrown
  // from along its front, the light flashing at the impact
  private explode(bolt: Bolt, target: Target) {
    const along =
      (target.position.x - bolt.origin.x) * bolt.direction.x +
      (target.position.z - bolt.origin.z) * bolt.direction.z;
    impact.copy(bolt.origin).addScaledVector(bolt.direction, along);
    const length = Math.min(BOLT_LENGTH * bolt.mesh.scale.y * BURST_ALONG, along);
    // The wake ends where the bolt did, and pulls on without it
    bolt.wake.reach = along;
    bolt.state = "bursting";
    bolt.time = 0;
    bolt.origin.copy(impact);
    bolt.mesh.visible = false;
    bolt.light.distance = BURST_LIGHT_RANGE;
    bolt.light.position.copy(impact);

    this.sparks.burst(impact, bolt.direction, length);
    this.mist.burst(impact, bolt.direction, length);
  }

  // The light flashing and dying
  private updateBurst(bolt: Bolt, delta: number) {
    bolt.time += delta;
    if (bolt.time >= BURST_TIME) {
      this.end(bolt);
      return;
    }
    bolt.light.intensity = BURST_LIGHT * (1 - bolt.time / BURST_TIME) ** 2;
  }

  private sweep(bolt: Bolt, from: number, to: number) {
    for (const target of this.targets) {
      if (target.team === bolt.team) continue;
      toTarget.set(target.position.x - bolt.origin.x, target.position.z - bolt.origin.z);
      const along = toTarget.x * bolt.direction.x + toTarget.y * bolt.direction.z;
      if (along < from - target.radius || along > to + target.radius) continue;
      const across = toTarget.x * bolt.direction.z - toTarget.y * bolt.direction.x;
      if (Math.abs(across) > target.radius) continue;
      return target;
    }
    return null;
  }

  // Where bolts are bursting, and seconds since each began
  *bursts() {
    for (const bolt of this.bolts) if (bolt.state === "bursting") yield { position: bolt.origin, time: bolt.time };
  }

  // Every bolt gone, flying or bursting. Debris settles on its own
  clear() {
    for (const bolt of this.bolts) this.end(bolt);
  }

  private end(bolt: Bolt) {
    bolt.state = "idle";
    bolt.mesh.visible = false;
    bolt.light.intensity = 0;
    bolt.light.visible = false;
  }

  dispose() {
    this.geometry.dispose();
    this.sparkGeometry.dispose();
    this.mistGeometry.dispose();
    this.mistMaterial.dispose();
    this.material.dispose();
  }
}

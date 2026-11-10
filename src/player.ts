import * as THREE from "three/webgpu";
import { Bot, type BotAssets } from "./bot";
import type { BoltPool, Target } from "./bolts";
import type { Controls } from "./controls";

// The player's bot: moves as the controls say, turns to their aim, and
// fires bolts towards it while they say so. One enemy bolt blows it apart,
// like the enemies, until revived

const MAX_SPEED = 4.5; // metres per second
const ACCELERATION = 8; // how quickly velocity reaches the input, per second
const FIRE_INTERVAL = 0.12; // seconds between shots while firing
// Until the rifle reports its muzzle, bolts aim on this plane
const AIM_HEIGHT = 1.2;

// How close an enemy bolt has to pass to hit
const HIT_RADIUS = 0.55;

// Dark Souls style hero light: a soft warm glow given off by the character,
// from its chest, lighting the ground around it a little. Decay below the
// physical 2, so it fades out more gently and covers more ground
const HERO_LIGHT_OFFSET = new THREE.Vector3(0, 1.4, 0);

const toTarget = new THREE.Vector3();
const move = new THREE.Vector3();

export function createPlayer(assets: BotAssets, bolts: BoltPool, controls: Controls) {
  const bot = new Bot(assets, "silver");
  // Where it looks, shared with the camera, which leads that way
  const aim = new THREE.Vector3(0, 0, 1);
  // Posed from the start, while nothing moves yet
  bot.update(0, aim);
  const heroLight = new THREE.PointLight("#ffe6c7", 2.4, 12, 1.5);
  const object = new THREE.Group().add(bot.object, heroLight);
  let cooldown = 0;
  let alive = true;

  const target: Target = {
    team: "player",
    position: bot.position,
    radius: HIT_RADIUS,
    hit: () => {
      bot.object.visible = false;
      alive = false;
    },
  };
  bolts.targets.add(target);

  // Back where it fell, standing still
  function revive() {
    bot.velocity.set(0, 0, 0);
    bot.object.visible = true;
    bolts.targets.add(target);
    alive = true;
  }

  function update(delta: number, camera: THREE.Camera) {
    if (!alive) return;
    // Aims level at muzzle height, so bolts fly through the aim point
    const muzzle = bot.muzzle;
    controls.read(camera, bot.position, muzzle.y > 0 ? muzzle.y : AIM_HEIGHT);
    if (controls.aiming) {
      toTarget.subVectors(controls.target, bot.position).setY(0);
      if (toTarget.lengthSq() > 1e-4) aim.copy(toTarget.normalize());
    }

    cooldown = Math.max(cooldown - delta, 0);
    if (controls.firing && cooldown === 0) {
      // From the muzzle to the aim point, unless that's too close to it
      toTarget.subVectors(controls.target, muzzle).setY(0);
      const direction = controls.aiming && toTarget.lengthSq() > 1 ? toTarget.normalize() : aim;
      bolts.fire("player", muzzle, direction);
      cooldown = FIRE_INTERVAL;
      bot.recoil();
    }

    move.copy(controls.move).multiplyScalar(MAX_SPEED);
    bot.velocity.lerp(move, 1 - Math.exp(-delta * ACCELERATION));
    bot.update(delta, aim);
    heroLight.position.copy(bot.position).add(HERO_LIGHT_OFFSET);
  }

  return {
    object,
    position: bot.position,
    velocity: bot.velocity,
    aim,
    update,
    revive,
    get alive() {
      return alive;
    },
  };
}

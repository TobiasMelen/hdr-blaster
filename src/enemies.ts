import * as THREE from "three/webgpu";
import { Bot, type BotAssets } from "./bot";
import type { BoltPool, Target } from "./bolts";

// Gold enemy bots: they appear past the top of the screen, walk down
// towards the player, then hold at range, strafing and shooting. One player
// bolt blows them apart (the bolt pool draws the burst), leaving blood on
// the grass, and they go back to the pool

const MAX_ENEMIES = 4;
const SPAWN_INTERVAL = 2.5; // seconds between arrivals while below the max
// Where they appear: this far past the top of the screen (world units up
// it), anywhere across its middle SPAWN_SPREAD
const SPAWN_PAST_TOP = 3;
const SPAWN_SPREAD = 0.8;
const DESPAWN_DISTANCE = 60; // wandered this far off, gone

const APPROACH_SPEED = 3.2; // metres per second
const STRAFE_SPEED = 1.6;
const ACCELERATION = 4; // how quickly velocity reaches the intent, per second
const ATTACK_RANGE = 12; // holds about this far from the player
// Seconds between shots, random between. A shot due while off screen is
// skipped, so one arriving waits out the rest of its tick
const FIRE_INTERVAL: [number, number] = [0.9, 1.6];
const AIM_ERROR = 0.15; // radians either side
// Shooting at a player moving across their line, how likely a miss falls
// behind it rather than ahead, where it would look led, and how fast
// across (metres per second) it has to be going for that to be sure
const BEHIND_CHANCE = 0.8;
const CROSSING_SPEED = 2;
const PERSONAL_SPACE = 2.2; // metres kept between enemies

const HIT_RADIUS = 0.6;

const toPlayer = new THREE.Vector3();
const intent = new THREE.Vector3();
const away = new THREE.Vector3();
const shot = new THREE.Vector3();
const onScreen = new THREE.Vector3();
const spawnAt = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

type Enemy = {
  bot: Bot;
  target: Target;
  active: boolean;
  cooldown: number;
  strafe: number; // -1 or 1, and when to reconsider it
  strafeTimer: number;
};

const random = (min: number, max: number) => min + Math.random() * (max - min);

export function createEnemies(
  assets: BotAssets,
  bolts: BoltPool,
  grassFeet: Set<THREE.Vector3>,
  player: THREE.Vector3,
  playerVelocity: THREE.Vector3,
  // Each enemy blown apart
  onKill: () => void
) {
  // A fixed pool, built up front so arrivals don't stall a frame
  const group = new THREE.Group();
  const enemies: Enemy[] = [];
  let spawnTimer = 1;
  const leave = (enemy: Enemy) => {
    enemy.active = false;
    enemy.bot.object.visible = false;
    bolts.targets.delete(enemy.target);
    grassFeet.delete(enemy.bot.position);
  };
  for (let i = 0; i < MAX_ENEMIES; i++) {
    const bot = new Bot(assets, "gold");
    bot.object.visible = false;
    group.add(bot.object);
    const enemy: Enemy = {
      bot,
      target: {
        team: "enemy",
        position: bot.position,
        radius: HIT_RADIUS,
        hit: () => {
          leave(enemy);
          onKill();
        },
      },
      active: false,
      cooldown: 0,
      strafe: 1,
      strafeTimer: 0,
    };
    enemies.push(enemy);
  }

  // One arriving past the top of the screen, from the pool
  function arrive(camera: THREE.OrthographicCamera) {
    const enemy = enemies.find((e) => !e.active);
    if (!enemy) return;
    const { bot } = enemy;
    bot.velocity.set(0, 0, 0);
    spawnAt.set(random(-SPAWN_SPREAD, SPAWN_SPREAD), 1 + SPAWN_PAST_TOP / camera.top);
    raycaster.setFromCamera(spawnAt, camera);
    raycaster.ray.intersectPlane(ground, bot.position);
    bot.face(toPlayer.subVectors(player, bot.position));
    bot.object.visible = true;
    enemy.active = true;
    enemy.cooldown = random(...FIRE_INTERVAL);
    enemy.strafe = Math.random() < 0.5 ? -1 : 1;
    enemy.strafeTimer = random(1.5, 3);
    bolts.targets.add(enemy.target);
    grassFeet.add(bot.position);
  }

  // Eases towards intent (kept apart from the others) and faces the player
  function move(enemy: Enemy, delta: number) {
    const { bot } = enemy;
    for (const other of enemies) {
      if (other === enemy || !other.active) continue;
      away.subVectors(bot.position, other.bot.position).setY(0);
      const gap = away.length();
      if (gap < PERSONAL_SPACE && gap > 1e-3) intent.addScaledVector(away, ((PERSONAL_SPACE - gap) / gap) * 2);
    }
    bot.velocity.lerp(intent, 1 - Math.exp(-delta * ACCELERATION));
    bot.update(delta, toPlayer.subVectors(player, bot.position).setY(0));
  }

  // Arrivals, then each closes in until at range and circles the player,
  // easing in or out to hold that range, and shoots at it, not quite dead
  // on and mostly behind it when it's moving, but only from inside the
  // camera's view
  function hunt(delta: number, camera: THREE.OrthographicCamera) {
    spawnTimer -= delta;
    if (spawnTimer <= 0) {
      spawnTimer = SPAWN_INTERVAL;
      arrive(camera);
    }
    for (const enemy of enemies) {
      if (!enemy.active) continue;
      const { bot } = enemy;
      toPlayer.subVectors(player, bot.position).setY(0);
      const distance = toPlayer.length();
      if (distance > DESPAWN_DISTANCE) {
        leave(enemy);
        continue;
      }
      toPlayer.divideScalar(Math.max(distance, 1e-3));

      enemy.strafeTimer -= delta;
      if (enemy.strafeTimer <= 0) {
        enemy.strafe = -enemy.strafe;
        enemy.strafeTimer = random(1.5, 3);
      }
      if (distance > ATTACK_RANGE + 2) {
        intent.copy(toPlayer).multiplyScalar(APPROACH_SPEED);
      } else {
        intent
          .set(-toPlayer.z, 0, toPlayer.x)
          .multiplyScalar(enemy.strafe * STRAFE_SPEED)
          .addScaledVector(toPlayer, THREE.MathUtils.clamp(distance - ATTACK_RANGE, -1, 1) * STRAFE_SPEED);
      }
      move(enemy, delta);

      enemy.cooldown -= delta;
      if (enemy.cooldown > 0) continue;
      enemy.cooldown = random(...FIRE_INTERVAL);
      onScreen.copy(bot.position).project(camera);
      if (Math.abs(onScreen.x) < 0.95 && Math.abs(onScreen.y) < 0.95) {
        shot.copy(player).sub(bot.muzzle).setY(0).normalize();
        // Turning the shot by a positive angle swings it towards (z, -x)
        const crossing = playerVelocity.x * shot.z - playerVelocity.z * shot.x;
        const behind = 0.5 + (BEHIND_CHANCE - 0.5) * Math.min(Math.abs(crossing) / CROSSING_SPEED, 1);
        const side = (Math.random() < behind ? -1 : 1) * Math.sign(crossing || 1);
        shot.applyAxisAngle(THREE.Object3D.DEFAULT_UP, side * random(0, AIM_ERROR));
        bolts.fire("enemy", bot.muzzle, shot);
        bot.recoil();
      }
    }
  }

  // Each comes to a standstill where it is
  function standDown(delta: number) {
    for (const enemy of enemies) {
      if (!enemy.active) continue;
      intent.set(0, 0, 0);
      move(enemy, delta);
    }
  }

  // All gone, the next arriving shortly after hunting resumes
  function clear() {
    for (const enemy of enemies) if (enemy.active) leave(enemy);
    spawnTimer = 1;
  }

  // Every enemy in and posed at once, so each one's shaders (one set per
  // skeleton) compile; clear() sends them off again
  function rehearse(camera: THREE.OrthographicCamera) {
    for (let i = 0; i < MAX_ENEMIES; i++) arrive(camera);
    for (const enemy of enemies) {
      intent.set(0, 0, 0);
      move(enemy, 1 / 60);
    }
  }

  return { object: group, hunt, standDown, clear, rehearse };
}

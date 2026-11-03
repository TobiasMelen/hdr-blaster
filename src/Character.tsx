import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three/webgpu";
import { ISO_RIGHT, ISO_UP } from "./iso";
import { Bot, useBotAssets } from "./bot";
import type { BoltPool, Target } from "./bolts";
import type { Aim } from "./Lasers";

// The player's bot: WASD moves it along the screen's axes, and it always
// aims at the mouse

const MAX_SPEED = 4.5; // metres per second
const ACCELERATION = 8; // how quickly velocity reaches the input, per second

// How close an enemy bolt has to pass to hit
const HIT_RADIUS = 0.55;

// Dark Souls style hero light: a soft warm glow given off by the character,
// from its chest, lighting the ground around it a little
const HERO_LIGHT_OFFSET: [number, number, number] = [0, 1.4, 0];
const HERO_LIGHT_COLOR = "#ffe6c7";
const HERO_LIGHT_INTENSITY = 2.4;
const HERO_LIGHT_RANGE = 12;
// Below the physical 2, so it fades out more gently and covers more ground
const HERO_LIGHT_DECAY = 1.5;

const KEYS = ["KeyW", "KeyA", "KeyS", "KeyD"] as const;
type Key = (typeof KEYS)[number];

export default function Character({
  position,
  aim,
  bolts,
}: {
  // Written every frame: the character's feet on the ground
  position: THREE.Vector3;
  aim: Aim;
  bolts: BoltPool;
}) {
  const assets = useBotAssets();
  // Nothing to free: it shares the assets' geometry and materials
  const bot = useMemo(() => new Bot(assets, "silver", position), [assets, position]);
  const heroLight = useRef<THREE.PointLight>(null);
  const shots = useRef(0);
  const keys = useRef<Record<Key, boolean>>({ KeyW: false, KeyA: false, KeyS: false, KeyD: false });

  // Enemy bolts stop on the player; there's no damage yet
  useEffect(() => {
    const target: Target = {
      team: "player",
      position,
      radius: HIT_RADIUS,
      explodes: false,
      hit: () => {},
    };
    bolts.targets.add(target);
    return () => void bolts.targets.delete(target);
  }, [bolts, position]);

  useEffect(() => {
    const set = (value: boolean) => (event: KeyboardEvent) => {
      if ((KEYS as readonly string[]).includes(event.code)) keys.current[event.code as Key] = value;
    };
    const down = set(true);
    const up = set(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useFrame((_, delta) => {
    const k = keys.current;

    // Input along the screen's ground axes
    const inputUp = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
    const inputRight = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
    const target = new THREE.Vector3(
      ISO_UP[0] * inputUp + ISO_RIGHT[0] * inputRight,
      0,
      ISO_UP[1] * inputUp + ISO_RIGHT[1] * inputRight
    );
    if (target.lengthSq() > 0) target.normalize().multiplyScalar(MAX_SPEED);
    bot.velocity.lerp(target, 1 - Math.exp(-delta * ACCELERATION));

    if (aim.shots !== shots.current) {
      shots.current = aim.shots;
      bot.recoil();
    }

    bot.update(delta, aim.direction);
    aim.muzzle.copy(bot.muzzle);
    heroLight.current?.position.set(...HERO_LIGHT_OFFSET).add(position);
  });

  return (
    <>
      <primitive object={bot.object} />
      <pointLight
        ref={heroLight}
        color={HERO_LIGHT_COLOR}
        intensity={HERO_LIGHT_INTENSITY}
        distance={HERO_LIGHT_RANGE}
        decay={HERO_LIGHT_DECAY}
      />
    </>
  );
}

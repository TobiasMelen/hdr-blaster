// Fixed isometric view shared by the camera and the camera-following grass

// Classic isometric elevation, atan(1 / sqrt(2)) ~ 35.26 degrees
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);

// World units visible from the bottom to the top of a 16:9 screen
export const ISO_VIEW_HEIGHT = 22;
const REFERENCE_ASPECT = 16 / 9;
// Screens smaller than this across (CSS pixels) see less, down to
// SMALLEST_VIEW of it, so things there stay big enough to make out
const FULL_VIEW_DIAGONAL = 1400;
const SMALLEST_VIEW = 0.7;

// World units the view covers across and up, for one this many CSS pixels:
// the same ground area a 16:9 one covers, whatever its shape
export function viewSize(width: number, height: number) {
  const aspect = width / height;
  const small = Math.min(Math.max(Math.hypot(width, height) / FULL_VIEW_DIAGONAL, SMALLEST_VIEW), 1);
  const up = ISO_VIEW_HEIGHT * Math.sqrt(REFERENCE_ASPECT / aspect) * small;
  return { width: up * aspect, height: up };
}

// Camera sits this far from its target along the view direction
export const ISO_DISTANCE = 60;

// Camera offset from its target: from the +x +z corner, looking down
export const ISO_OFFSET: [number, number, number] = [
  (ISO_DISTANCE * Math.cos(ISO_ELEVATION)) / Math.SQRT2,
  ISO_DISTANCE * Math.sin(ISO_ELEVATION),
  (ISO_DISTANCE * Math.cos(ISO_ELEVATION)) / Math.SQRT2,
];

// Ground axes of the view: screen right, and screen up (away from camera)
export const ISO_RIGHT: [number, number] = [Math.SQRT1_2, -Math.SQRT1_2];
export const ISO_UP: [number, number] = [-Math.SQRT1_2, -Math.SQRT1_2];

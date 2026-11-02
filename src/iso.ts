// Fixed isometric view shared by the camera and the camera-following grass

// Classic isometric elevation, atan(1 / sqrt(2)) ~ 35.26 degrees
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);

// World units visible from the bottom to the top of the screen
export const ISO_VIEW_HEIGHT = 22;

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

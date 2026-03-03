import type { Transition, Variants } from "framer-motion";

const EASE_STANDARD: [number, number, number, number] = [0.22, 1, 0.36, 1];

export const MOTION_TOKENS = {
  duration: {
    fast: 0.16,
    normal: 0.24,
    slow: 0.32,
  },
  spring: {
    stiffness: 320,
    damping: 30,
    mass: 0.8,
  },
} as const;

export function motionTransition(
  reducedMotion: boolean,
  duration: number = MOTION_TOKENS.duration.normal,
): Transition {
  if (reducedMotion) {
    return { duration: 0 };
  }

  return {
    duration,
    ease: EASE_STANDARD,
  };
}

export function panelVariants(
  reducedMotion: boolean,
  direction: "left" | "right",
): Variants {
  const offset = direction === "left" ? -20 : 20;

  if (reducedMotion) {
    return {
      hidden: { opacity: 1, x: 0 },
      visible: { opacity: 1, x: 0 },
      exit: { opacity: 1, x: 0 },
    };
  }

  return {
    hidden: { opacity: 0, x: offset },
    visible: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: offset * 0.5 },
  };
}

export function fadeVariants(reducedMotion: boolean): Variants {
  if (reducedMotion) {
    return {
      hidden: { opacity: 1 },
      visible: { opacity: 1 },
      exit: { opacity: 1 },
    };
  }

  return {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
    exit: { opacity: 0 },
  };
}

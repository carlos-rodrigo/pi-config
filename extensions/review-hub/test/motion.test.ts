import { test } from "node:test";
import assert from "node:assert/strict";

import { fadeVariants, motionTransition, panelVariants } from "../web-app/src/lib/motion.ts";

test("motionTransition respects reduced-motion preference", () => {
  assert.equal(motionTransition(true).duration, 0);
  assert.equal(motionTransition(false, 0.24).duration, 0.24);
});

test("panelVariants disable offsets when reduced motion is enabled", () => {
  const reduced = panelVariants(true, "left");
  assert.deepEqual(reduced.hidden, { opacity: 1, x: 0 });

  const animated = panelVariants(false, "right");
  assert.deepEqual(animated.hidden, { opacity: 0, x: 20 });
  assert.deepEqual(animated.visible, { opacity: 1, x: 0 });
});

test("fadeVariants collapse to static opacity when reduced motion is enabled", () => {
  const reduced = fadeVariants(true);
  assert.deepEqual(reduced.hidden, { opacity: 1 });

  const animated = fadeVariants(false);
  assert.deepEqual(animated.hidden, { opacity: 0 });
  assert.deepEqual(animated.visible, { opacity: 1 });
});

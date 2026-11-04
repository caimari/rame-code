import assert from "node:assert/strict";
import test from "node:test";

import { add } from "../src/calculator.js";

test("acceptance: addition remains correct across representative boundaries", () => {
  assert.equal(add(0, 0), 0);
  assert.equal(add(19, 23), 42);
  assert.equal(add(-7, 7), 0);
  assert.equal(add(-8, -5), -13);
});

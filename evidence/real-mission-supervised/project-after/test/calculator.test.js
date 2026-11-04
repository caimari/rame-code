import assert from "node:assert/strict";
import test from "node:test";

import { add } from "../src/calculator.js";

test("add sums positive integers", () => {
  assert.equal(add(2, 3), 5);
});

test("add handles a negative operand", () => {
  assert.equal(add(-2, 5), 3);
});

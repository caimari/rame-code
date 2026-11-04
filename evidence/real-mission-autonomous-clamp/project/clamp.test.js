const test = require('node:test');
const assert = require('node:assert/strict');
const { clamp } = require('./clamp.js');

test('value inside range returns value', () => {
  assert.strictEqual(clamp(5, 0, 10), 5);
});

test('value below minimum returns minimum', () => {
  assert.strictEqual(clamp(-1, 0, 10), 0);
});

test('value above maximum returns maximum', () => {
  assert.strictEqual(clamp(20, 0, 10), 10);
});

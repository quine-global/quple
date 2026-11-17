// Just enough of Jest's expect() for the shared watchdog tests.
import assert from 'node:assert/strict';

export const expect = (actual) => ({
  toEqual: (expected) => assert.deepStrictEqual(actual, expected),
});

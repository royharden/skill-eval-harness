import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSize } from '../src/parse.js';

test('parseSize reads WIDTHxHEIGHT', () => {
  assert.deepStrictEqual(parseSize('120x40'), { width: 120, height: 40 });
});

test('parseSize rejects malformed input', () => {
  assert.throws(() => parseSize('wide'), TypeError);
});

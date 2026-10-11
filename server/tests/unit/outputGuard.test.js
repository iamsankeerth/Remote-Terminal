import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WS_MAX_OUTPUT_BUFFER_BYTES } from '@remote-terminal/shared';
import { isClientOverBuffer, outputBufferLimitBytes } from '../../src/websocket/outputGuard.js';

test('the output buffer limit matches the PRD value', () => {
  assert.equal(outputBufferLimitBytes(), 1024 * 1024);
  assert.equal(WS_MAX_OUTPUT_BUFFER_BYTES, 1024 * 1024);
});

test('a healthy client is never considered slow', () => {
  assert.equal(isClientOverBuffer({ bufferedAmount: 0 }), false);
  assert.equal(isClientOverBuffer({ bufferedAmount: 512 }), false);
  assert.equal(isClientOverBuffer({ bufferedAmount: WS_MAX_OUTPUT_BUFFER_BYTES - 1 }), false);
});

test('a client whose socket buffer exceeds 1 MiB is flagged as slow', () => {
  assert.equal(isClientOverBuffer({ bufferedAmount: WS_MAX_OUTPUT_BUFFER_BYTES + 1 }), true);
  assert.equal(isClientOverBuffer({ bufferedAmount: 5 * 1024 * 1024 }), true);
});

test('a missing or non-numeric bufferedAmount is treated as healthy', () => {
  assert.equal(isClientOverBuffer({}), false);
  assert.equal(isClientOverBuffer({ bufferedAmount: undefined }), false);
  assert.equal(isClientOverBuffer({ bufferedAmount: null }), false);
  assert.equal(isClientOverBuffer(undefined), false);
});

test('the limit is configurable for callers with a different budget', () => {
  assert.equal(isClientOverBuffer({ bufferedAmount: 500 }, 100), true);
  assert.equal(isClientOverBuffer({ bufferedAmount: 50 }, 100), false);
});

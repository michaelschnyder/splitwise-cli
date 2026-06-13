import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEffectiveLogLevel } from '../src/lib/output.js';

test('SW_DEBUG forces trace regardless of flags', () => {
  const level = resolveEffectiveLogLevel({
    swDebug: true,
    log: 'error',
    verbose: 0,
    format: 'json',
  });
  assert.equal(level, 'trace');
});

test('--log level is respected when SW_DEBUG is disabled', () => {
  const level = resolveEffectiveLogLevel({
    swDebug: false,
    log: 'debug',
    verbose: 1,
    format: 'json',
  });
  assert.equal(level, 'debug');
});

test('-v verbosity mapping', () => {
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, verbose: 1, format: 'json' }), 'info');
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, verbose: 2, format: 'json' }), 'debug');
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, verbose: 3, format: 'json' }), 'trace');
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, verbose: 4, format: 'json' }), 'trace');
});

test('default log level for table and structured output', () => {
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, format: 'table' }), 'info');
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, format: 'json' }), 'warn');
  assert.equal(resolveEffectiveLogLevel({ swDebug: false, format: 'yaml' }), 'warn');
});

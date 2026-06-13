import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEffectiveCacheTarget, resolveEffectiveOffline } from '../src/lib/config.js';

test('offline resolution prefers explicit offline flag', () => {
  assert.equal(resolveEffectiveOffline({ requestedOffline: true, profileOfflineEnabled: false }), true);
  assert.equal(resolveEffectiveOffline({ requestedOffline: true, profileOfflineEnabled: true }), true);
});

test('offline resolution falls back to profile default', () => {
  assert.equal(resolveEffectiveOffline({ requestedOffline: false, profileOfflineEnabled: true }), true);
  assert.equal(resolveEffectiveOffline({ requestedOffline: false, profileOfflineEnabled: false }), false);
  assert.equal(resolveEffectiveOffline({}), false);
});

test('cache target resolution prefers explicit target over profile target', () => {
  assert.equal(resolveEffectiveCacheTarget({ requestedTarget: 'global', profilePreferredTarget: 'local' }), 'global');
  assert.equal(resolveEffectiveCacheTarget({ requestedTarget: 'user', profilePreferredTarget: 'global' }), 'user');
});

test('cache target resolution falls back to profile target and then local', () => {
  assert.equal(resolveEffectiveCacheTarget({ profilePreferredTarget: 'user' }), 'user');
  assert.equal(resolveEffectiveCacheTarget({}), 'local');
  assert.equal(resolveEffectiveCacheTarget({ requestedTarget: 'invalid', profilePreferredTarget: 'global' }), 'global');
});
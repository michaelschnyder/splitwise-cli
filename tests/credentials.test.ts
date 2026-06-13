import assert from 'node:assert/strict';
import test from 'node:test';
import { maskCredentialToken, resolveCredentialNameFromInputs } from '../src/lib/config.js';

test('credential selection precedence', () => {
  assert.equal(
    resolveCredentialNameFromInputs({
      requested: 'cli',
      profileCredential: 'profile',
      activeCredential: 'active',
      defaultCredential: 'default',
    }),
    'cli',
  );

  assert.equal(
    resolveCredentialNameFromInputs({
      profileCredential: 'profile',
      activeCredential: 'active',
      defaultCredential: 'default',
    }),
    'profile',
  );

  assert.equal(
    resolveCredentialNameFromInputs({
      activeCredential: 'active',
      defaultCredential: 'default',
    }),
    'active',
  );

  assert.equal(
    resolveCredentialNameFromInputs({
      defaultCredential: 'default',
    }),
    'default',
  );

  assert.equal(resolveCredentialNameFromInputs({}), null);
});

test('token masking format', () => {
  assert.equal(maskCredentialToken({ accessToken: 'abcdefgh12345' }), 'abcd****345');
  assert.equal(maskCredentialToken({ accessToken: 'abc123' }), 'ab****23');
  assert.equal(maskCredentialToken({ consumerKey: 'oauth-key-999' }), 'oaut****999');
  assert.equal(maskCredentialToken({}), '');
});

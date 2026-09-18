'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.MODEL_RELAY_MASTER_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const { encryptSecret, decryptSecret, maskSecret } = require('./secrets.cjs');

test('encrypts provider keys without storing plaintext', () => {
  const sealed = encryptSecret('sk-provider-test');
  assert.notEqual(sealed, 'sk-provider-test');
  assert.match(sealed, /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(decryptSecret(sealed), 'sk-provider-test');
  assert.equal(maskSecret('sk-provider-test'), '***test');
  assert.equal(maskSecret('abc'), '***');
});

test('fails closed when the master key is invalid', () => {
  const previous = process.env.MODEL_RELAY_MASTER_KEY;
  process.env.MODEL_RELAY_MASTER_KEY = 'bad';
  assert.throws(() => encryptSecret('secret'), /64 hexadecimal/);
  process.env.MODEL_RELAY_MASTER_KEY = previous;
});

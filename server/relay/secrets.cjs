'use strict';

const crypto = require('node:crypto');

function masterKey() {
  const value = String(process.env.MODEL_RELAY_MASTER_KEY || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error('MODEL_RELAY_MASTER_KEY must be exactly 64 hexadecimal characters');
  }
  return Buffer.from(value, 'hex');
}

function encryptSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('secret must be a non-empty string');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptSecret(sealed) {
  const parts = String(sealed || '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('invalid secret ciphertext');
  const [, ivHex, tagHex, ciphertextHex] = parts;
  if (!/^[0-9a-f]+$/i.test(ivHex) || !/^[0-9a-f]+$/i.test(tagHex) || !/^[0-9a-f]+$/i.test(ciphertextHex)) {
    throw new Error('invalid secret ciphertext encoding');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error(`secret decryption failed: ${error.message}`);
  }
}

function maskSecret(secret) {
  const value = String(secret || '');
  return value.length < 4 ? '***' : `***${value.slice(-4)}`;
}

function validateMasterKey() {
  masterKey();
  return true;
}

module.exports = { encryptSecret, decryptSecret, maskSecret, validateMasterKey };

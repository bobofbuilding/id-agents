import { randomBytes } from 'node:crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, keccak256, stringToHex } from 'viem';

const DERIVATION_SALT = new TextEncoder().encode('bittrees:contributor-encryption:v1');
const ENVELOPE_INFO = new TextEncoder().encode('bittrees:application-envelope:v1');
const DEFAULT_AAD = new TextEncoder().encode('bittrees.contributor.application.v1');

function asHexBytes(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${label} must be an even-length 0x-prefixed hex value`);
  }
  return hexToBytes(value);
}

function deriveEnvelopeKey(sharedSecret, ephemeralPublicKey, recipientPublicKey) {
  const salt = sha256(Uint8Array.from([...ephemeralPublicKey, ...recipientPublicKey]));
  return hkdf(sha256, sharedSecret, salt, ENVELOPE_INFO, 32);
}

export function canonicalApplication(application) {
  if (application === null || Array.isArray(application) || typeof application !== 'object') {
    throw new Error('Application must be a JSON object');
  }
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    }
    return value;
  };
  return JSON.stringify(sort(application));
}

/**
 * Derives an X25519 encryption keypair from a wallet-produced signature.
 * The signature is treated as secret key material and must never be logged.
 */
export function deriveEncKeypair(walletSignature) {
  const signatureBytes = asHexBytes(walletSignature, 'Wallet signature');
  if (signatureBytes.length < 64) {
    throw new Error('Wallet signature must contain at least 64 bytes');
  }
  const privateKey = hkdf(sha256, signatureBytes, DERIVATION_SALT, ENVELOPE_INFO, 32);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey: bytesToHex(privateKey), publicKey: bytesToHex(publicKey) };
}

export function encryptApplication(application, recipientPublicKeyHex, options = {}) {
  const recipientPublicKey = asHexBytes(recipientPublicKeyHex, 'Recipient public key');
  if (recipientPublicKey.length !== 32) throw new Error('Recipient public key must be 32 bytes');

  const ephemeralPrivateKey = options.ephemeralPrivateKey
    ? asHexBytes(options.ephemeralPrivateKey, 'Ephemeral private key')
    : randomBytes(32);
  const nonce = options.nonce ? asHexBytes(options.nonce, 'Nonce') : randomBytes(12);
  if (ephemeralPrivateKey.length !== 32) throw new Error('Ephemeral private key must be 32 bytes');
  if (nonce.length !== 12) throw new Error('ChaCha20-Poly1305 nonce must be 12 bytes');

  const ephemeralPublicKey = x25519.getPublicKey(ephemeralPrivateKey);
  const sharedSecret = x25519.getSharedSecret(ephemeralPrivateKey, recipientPublicKey);
  const key = deriveEnvelopeKey(sharedSecret, ephemeralPublicKey, recipientPublicKey);
  const plaintext = new TextEncoder().encode(canonicalApplication(application));
  const ciphertext = chacha20poly1305(key, nonce, DEFAULT_AAD).encrypt(plaintext);

  return {
    version: 1,
    algorithm: 'X25519-HKDF-SHA256-CHACHA20-POLY1305',
    ephemeralPublicKey: bytesToHex(ephemeralPublicKey),
    recipientPublicKey: bytesToHex(recipientPublicKey),
    nonce: bytesToHex(nonce),
    aad: 'bittrees.contributor.application.v1',
    applicationHash: keccak256(stringToHex(new TextDecoder().decode(plaintext))),
    ciphertext: bytesToHex(ciphertext),
  };
}

export function decryptApplication(envelope, recipientPrivateKeyHex) {
  const recipientPrivateKey = asHexBytes(recipientPrivateKeyHex, 'Recipient private key');
  const ephemeralPublicKey = asHexBytes(envelope.ephemeralPublicKey, 'Ephemeral public key');
  const recipientPublicKey = x25519.getPublicKey(recipientPrivateKey);
  if (bytesToHex(recipientPublicKey).toLowerCase() !== envelope.recipientPublicKey.toLowerCase()) {
    throw new Error('Recipient private key does not match envelope public key');
  }
  const nonce = asHexBytes(envelope.nonce, 'Nonce');
  const ciphertext = asHexBytes(envelope.ciphertext, 'Ciphertext');
  const sharedSecret = x25519.getSharedSecret(recipientPrivateKey, ephemeralPublicKey);
  const key = deriveEnvelopeKey(sharedSecret, ephemeralPublicKey, recipientPublicKey);
  const plaintext = chacha20poly1305(key, nonce, DEFAULT_AAD).decrypt(ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

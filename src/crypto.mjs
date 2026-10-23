import { randomBytes } from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_384 } from '@noble/hashes/sha3.js';

const PUBLIC_KEY_BYTES = 1952;
const SIGNATURE_BYTES = 3309;
const SIGNING_DOMAIN = 'Frobenius/Beans/signed-payload/v1\0';
const ADDRESS_DOMAIN = 'Frobenius/Beans/address/v1\0';
const UNIT = 1_000_000n;
const MAX_PAYLOAD_BYTES = 128 * 1024;
// A validator approval includes up to 100 ML-DSA public keys (~404 KiB).
// Keep the smaller bound for transfers and votes; existing signing bytes stay identical.
const MAX_VALIDATOR_APPROVAL_BYTES = 512 * 1024;

function hexBytes(value, length, label) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new TypeError(`${label} must be ${length} bytes encoded as lowercase hexadecimal.`);
  }
  return new Uint8Array(Buffer.from(value, 'hex'));
}

/** Stable JSON for signing: only unambiguous, ordinary JSON values are accepted. */
export function canonicalJSON(value, maxBytes = MAX_PAYLOAD_BYTES) {
  const ancestors = new Set();
  function encode(item, depth) {
    if (depth > 64) throw new TypeError('JSON nesting exceeds the supported limit.');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || !Number.isSafeInteger(item)) {
        throw new TypeError('Signed JSON numbers must be safe integers; encode amounts as strings.');
      }
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('Unsupported JSON value.');
    if (ancestors.has(item)) throw new TypeError('Circular JSON is not supported.');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Only plain JSON objects can be signed.');
    }
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('Symbol keys cannot be signed.');
    ancestors.add(item);
    let result;
    if (Array.isArray(item)) {
      const parts = [];
      for (let i = 0; i < item.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, i);
        if (!descriptor) throw new TypeError('Sparse arrays cannot be signed.');
        if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors cannot be signed.');
        parts.push(encode(descriptor.value, depth + 1));
      }
      if (Object.keys(item).length !== item.length) throw new TypeError('Array properties cannot be signed.');
      result = `[${parts.join(',')}]`;
    } else {
      result = `{${Object.keys(item).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('JSON accessors cannot be signed.');
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }
  const result = encode(value, 0);
  if (Buffer.byteLength(result, 'utf8') > maxBytes) throw new RangeError('JSON payload is too large.');
  return result;
}

export function sha3Hex(input) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    throw new TypeError('Hash input must be a string or Uint8Array.');
  }
  return Buffer.from(sha3_384(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)).toString('hex');
}

export function addressFromPublicKey(publicKeyHex) {
  const publicKey = hexBytes(publicKeyHex, PUBLIC_KEY_BYTES, 'Public key');
  const digest = sha3Hex(publicKey);
  return `beans1${digest}${sha3Hex(ADDRESS_DOMAIN + digest).slice(0, 8)}`;
}

export function validateAddress(address) {
  if (typeof address !== 'string' || !/^beans1[0-9a-f]{104}$/.test(address)) return false;
  const digest = address.slice(6, 102);
  return address.slice(102) === sha3Hex(ADDRESS_DOMAIN + digest).slice(0, 8);
}

/** Low-level key generation. WalletStore keeps the seed inside its encrypted vault. */
export function generateWallet(seed = new Uint8Array(randomBytes(32))) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new TypeError('Wallet seed must be 32 bytes.');
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  try {
    const publicKeyHex = Buffer.from(publicKey).toString('hex');
    return { seed: Buffer.from(seed).toString('hex'), publicKey: publicKeyHex, address: addressFromPublicKey(publicKeyHex) };
  } finally {
    secretKey.fill(0);
  }
}

function signingBytes(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new TypeError('Signed payload must be an object.');
  }
  const limit = payload.type === 'validators' ? MAX_VALIDATOR_APPROVAL_BYTES : MAX_PAYLOAD_BYTES;
  return new Uint8Array(Buffer.from(SIGNING_DOMAIN + canonicalJSON(payload, limit), 'utf8'));
}

/**
 * Signatures are hedged (randomized) by default. `deterministic` exists only for
 * reproducible test vectors; both forms verify identically.
 */
export function signPayload(payload, seedHex, { deterministic = false } = {}) {
  const seed = hexBytes(seedHex, 32, 'Wallet seed');
  const message = signingBytes(payload);
  let secretKey;
  try {
    const pair = ml_dsa65.keygen(seed);
    secretKey = pair.secretKey;
    const signature = ml_dsa65.sign(message, secretKey, deterministic ? { extraEntropy: false } : undefined);
    return { publicKey: Buffer.from(pair.publicKey).toString('hex'), signature: Buffer.from(signature).toString('hex') };
  } finally {
    seed.fill(0);
    secretKey?.fill(0);
  }
}

export function verifyPayload(payload, publicKeyHex, signatureHex) {
  try {
    const publicKey = hexBytes(publicKeyHex, PUBLIC_KEY_BYTES, 'Public key');
    const signature = hexBytes(signatureHex, SIGNATURE_BYTES, 'Signature');
    return ml_dsa65.verify(signature, signingBytes(payload), publicKey) === true;
  } catch {
    return false;
  }
}

/** Exact nonnegative decimal conversion; one Bean is one million base units. */
export function parseBeans(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) {
    throw new TypeError('Enter a nonnegative Bean amount with at most 6 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(6, '0'));
}

export function formatBeans(value) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))) {
    throw new TypeError('Base units must be a nonnegative BigInt or canonical integer string.');
  }
  const amount = BigInt(value);
  if (amount < 0n) throw new RangeError('Base units cannot be negative.');
  const fraction = (amount % UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${amount / UNIT}${fraction ? `.${fraction}` : ''}`;
}

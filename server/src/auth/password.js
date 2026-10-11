import crypto from 'node:crypto';
import { ARGON2_PARAMS } from '@remote-terminal/shared';
import { ValidationError } from '@remote-terminal/shared';

/**
 * Node 24.7+ exposes asynchronous native Argon2id through `crypto.argon2`.
 *
 * The callback API is promisified here: the option names are Node's (`message`, `nonce`,
 * `memory`, `passes`, `parallelism`, `tagLength`), which map onto the Argon2id parameters
 * recorded in ARGON2_PARAMS so verification can reconstruct them exactly.
 */
const argon2 = crypto.argon2;

export function assertArgon2Available() {
  if (typeof argon2 !== 'function') {
    throw new ValidationError(
      'Native Argon2id is unavailable. Node.js 24.7 or newer is required.',
      'internal',
    );
  }
}

function argon2Async(options) {
  assertArgon2Available();
  return new Promise((resolve, reject) => {
    argon2('argon2id', options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Hashes a password with Argon2id using a random 16-byte salt.
 * Returns a storable record containing algorithm and parameters so verification can reconstruct
 * them. The record contains no plaintext password.
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const record = await derive(password, salt, ARGON2_PARAMS);
  return {
    algorithm: 'argon2id',
    saltBase64: salt.toString('base64'),
    hashBase64: Buffer.from(record).toString('base64'),
    params: {
      memoryCost: ARGON2_PARAMS.memoryCost,
      timeCost: ARGON2_PARAMS.timeCost,
      parallelism: ARGON2_PARAMS.parallelism,
      tagLength: ARGON2_PARAMS.tagLength,
    },
    createdAt: new Date().toISOString(),
  };
}

async function derive(password, salt, params) {
  return argon2Async({
    message: Buffer.from(password, 'utf8'),
    nonce: salt,
    memory: params.memoryCost,
    passes: params.timeCost,
    parallelism: params.parallelism,
    tagLength: params.tagLength,
  });
}

/** Constant-time comparison of derived keys. Returns false on any mismatch. */
export async function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'argon2id') return false;
  let derived;
  try {
    derived = await derive(password, Buffer.from(record.saltBase64, 'base64'), record.params);
  } catch {
    return false;
  }
  const expected = Buffer.from(record.hashBase64, 'base64');
  const d = Buffer.from(derived);
  if (d.length !== expected.length) return false;
  return crypto.timingSafeEqual(d, expected);
}

export default { hashPassword, verifyPassword, assertArgon2Available };

import crypto from 'node:crypto';
import { ValidationError } from '@remote-terminal/shared';

export function base64urlToBuffer(value) {
  return Buffer.from(value, 'base64url');
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates a Cloudflare Access JWT assertion.
 *
 * Fail-closed: any unknown shape, bad signature, wrong issuer, wrong audience, expiry, token
 * type, or owner email denies. The JWKS is cached and refreshed with a remote fetch, and a
 * failed remote refresh while cached keys exist still allows the cached keys to be used until
 * their natural expiry, but a missing or malformed assertion always denies.
 */
export class CloudflareAssertionValidator {
  constructor({ teamDomain, aud, ownerEmail, fetchImpl = fetch, logger, now = () => Date.now() }) {
    this.teamDomain = teamDomain;
    this.aud = aud;
    this.ownerEmail = ownerEmail;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.jwks = null;
    this.jwksFetchedAt = 0;
    this.jwksTtlMs = 10 * 60 * 1000;
  }

  get issuer() {
    return `https://${this.teamDomain}.cloudflareaccess.com`;
  }

  async loadKeys(force = false) {
    if (!force && this.jwks && this.now() - this.jwksFetchedAt < this.jwksTtlMs) {
      return this.jwks;
    }
    const url = `${this.issuer}/cdn-cgi/access/certs`;
    const response = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`JWKS fetch failed with status ${response.status}`);
    const body = await response.json();
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new Error('JWKS response contained no keys');
    }
    this.jwks = body.keys;
    this.jwksFetchedAt = this.now();
    return this.jwks;
  }

  decodeSegments(jwt) {
    const parts = String(jwt).split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = parts;
    let header;
    let payload;
    try {
      header = JSON.parse(base64urlToBuffer(headerB64).toString('utf8'));
      payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
    } catch {
      return null;
    }
    return { header, payload, signature: base64urlToBuffer(signatureB64), signed: `${headerB64}.${payloadB64}` };
  }

  findKey(kid) {
    if (!this.jwks) return null;
    return this.jwks.find((key) => key.kid === kid) ?? null;
  }

  verifySignature(signed, signature, jwk) {
    if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return false;
    const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signed);
    verifier.end();
    return verifier.verify(keyObject, signature);
  }

  /** Returns { ok: true, claims } or { ok: false, reason }. Never throws. */
  async validate(jwt) {
    if (typeof jwt !== 'string' || jwt.length === 0) return { ok: false, reason: 'missing_assertion' };
    const decoded = this.decodeSegments(jwt);
    if (!decoded) return { ok: false, reason: 'malformed_jwt' };
    const { header, payload, signature, signed } = decoded;

    let keys;
    try {
      keys = await this.loadKeys();
    } catch (error) {
      if (!this.jwks) {
        this.logger?.warn('cloudflare_jwks_unavailable', { reason: 'fetch_failed_no_cache' });
        return { ok: false, reason: 'jwks_unavailable' };
      }
      this.logger?.warn('cloudflare_jwks_refresh_failed_using_cache', {});
      keys = this.jwks;
    }

    const jwk = this.findKey(header.kid);
    if (!jwk) return { ok: false, reason: 'unknown_key_id' };
    if (!this.verifySignature(signed, signature, jwk)) return { ok: false, reason: 'bad_signature' };

    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return { ok: false, reason: 'expired' };
    if (payload.iss !== this.issuer) return { ok: false, reason: 'wrong_issuer' };
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.aud)) return { ok: false, reason: 'wrong_audience' };
    const type = payload.type ?? header.typ;
    if (type !== 'app' && type !== 'JWT') return { ok: false, reason: 'wrong_token_type' };
    if (String(payload.email ?? '').toLowerCase() !== String(this.ownerEmail).toLowerCase()) {
      return { ok: false, reason: 'wrong_email' };
    }
    return { ok: true, claims: { email: payload.email, exp: payload.exp, sub: payload.sub } };
  }
}

export function hashClientIdentity({ ip, userAgent }) {
  return crypto.createHash('sha256').update(`${ip ?? ''}|${userAgent ?? ''}`).digest('hex').slice(0, 32);
}

export { timingSafeEqualStr, ValidationError };

export default CloudflareAssertionValidator;

import { CONFIG_PATH } from './fsPaths.js';
import { readJsonFile, writeJsonFileAtomic, ensureDir } from './fsPaths.js';

export const CONFIG_SCHEMA_VERSION = 1;

export function defaultConfig() {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    owner: { username: '', password: null },
    server: { port: 0, cloudflareOrigin: '', tunnelMode: 'quick' },
    cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
    limits: { sessions: 1, connections: 1 },
  };
}

/** Normalizes an untrusted config object into known shape with validated required fields. */
export function normalizeConfig(raw) {
  const base = defaultConfig();
  const input = raw && typeof raw === 'object' ? raw : {};
  const merged = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    owner: {
      username: String(input.owner?.username ?? base.owner.username),
      password: input.owner?.password ?? base.owner.password,
    },
    server: {
      port: Number(input.server?.port ?? base.server.port),
      cloudflareOrigin: String(input.server?.cloudflareOrigin ?? base.server.cloudflareOrigin),
      tunnelMode: normalizeTunnelMode(input.server?.tunnelMode ?? base.server.tunnelMode),
    },
    cloudflare: {
      hostname: String(input.cloudflare?.hostname ?? base.cloudflare.hostname),
      teamDomain: String(input.cloudflare?.teamDomain ?? base.cloudflare.teamDomain),
      aud: String(input.cloudflare?.aud ?? base.cloudflare.aud),
      ownerEmail: String(input.cloudflare?.ownerEmail ?? base.cloudflare.ownerEmail),
    },
    limits: {
      sessions: Number(input.limits?.sessions ?? base.limits.sessions),
      connections: Number(input.limits?.connections ?? base.limits.connections),
    },
  };
  return merged;
}

/** `quick` deploys an ephemeral Cloudflare tunnel on every start (default). `named` means the
 *  Owner configured a hostname and manages Cloudflare Access manually. */
export function normalizeTunnelMode(value) {
  return value === 'named' ? 'named' : 'quick';
}

export class ConfigStore {
  constructor({ path = CONFIG_PATH } = {}) {
    this.path = path;
  }

  exists() {
    return readJsonFile(this.path, null) !== null;
  }

  load() {
    const raw = readJsonFile(this.path, null);
    if (raw === null) return null;
    return normalizeConfig(raw);
  }

  save(config) {
    ensureDir(this.path.replace(/[^/\\]*$/, ''), 0o700);
    writeJsonFileAtomic(this.path, normalizeConfig(config));
  }
}

export default ConfigStore;

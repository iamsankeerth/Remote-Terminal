/**
 * Shared state describing the currently active quick tunnel.
 *
 * The HTTP layer and the WebSocket gateway both consult this so they can accept the ephemeral
 * tunnel origin and skip the Cloudflare Access assertion while a tunnel is running, without
 * importing each other.
 */

let running = false;
let origin = null;

function normalize(originValue) {
  if (typeof originValue !== 'string' || originValue === '') return null;
  try {
    const url = new URL(originValue);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export function setActiveTunnel(originValue) {
  origin = normalize(originValue);
  running = origin !== null;
  return origin;
}

export function clearActiveTunnel() {
  running = false;
  origin = null;
}

export function isTunnelRunning() {
  return running;
}

export function getTunnelOrigin() {
  return origin;
}

/** True only when the given origin is exactly the tunnel URL we are currently serving. */
export function isTunnelOrigin(originValue) {
  if (!running || !origin) return false;
  return normalize(originValue) === origin;
}

export default {
  setActiveTunnel,
  clearActiveTunnel,
  isTunnelRunning,
  getTunnelOrigin,
  isTunnelOrigin,
};

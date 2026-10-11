import {
  PROTOCOL_VERSION,
  WS_CLIENT_TYPES,
  WS_SERVER_TYPES,
  SESSION_ACTIONS,
  SESSION_LABEL_MIN_CODE_POINTS,
  SESSION_LABEL_MAX_CODE_POINTS,
  HTTP_MAX_BODY_BYTES,
  PASSWORD_MIN_CODE_POINTS,
  PASSWORD_MAX_CODE_POINTS,
} from './constants.js';

export class ValidationError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export function codePointLength(value) {
  return [...value].length;
}
export function assertValidPassword(value) {
  if (typeof value !== 'string') throw new ValidationError('Password must be a string.');
  const len = codePointLength(value);
  if (len < PASSWORD_MIN_CODE_POINTS || len > PASSWORD_MAX_CODE_POINTS) {
    throw new ValidationError(
      `Password must be ${PASSWORD_MIN_CODE_POINTS} to ${PASSWORD_MAX_CODE_POINTS} Unicode code points.`,
    );
  }
}

export function normalizeForUniqueLabel(value) {
  return [...value].map((ch) => ch.toLocaleLowerCase()).join('');
}

export function assertValidLabel(value) {
  if (typeof value !== 'string') throw new ValidationError('Label must be a string.');
  const len = codePointLength(value.trim());
  if (len < SESSION_LABEL_MIN_CODE_POINTS || len > SESSION_LABEL_MAX_CODE_POINTS) {
    throw new ValidationError(
      `Label must be ${SESSION_LABEL_MIN_CODE_POINTS} to ${SESSION_LABEL_MAX_CODE_POINTS} Unicode code points.`,
    );
  }
  for (const ch of value) {
    if (ch === '\u0000') throw new ValidationError('Label must not contain NUL.');
  }
}

/**
 * Terminal Session display labels are opaque to the shell. They are never interpolated into
 * shell or tmux commands: tmux targets always use the internal namespaced identifier.
 */
export function assertSafeLabelForShell(value) {
  if (/[;|&$`\n\r"']/.test(value)) {
    throw new ValidationError('Label must not contain shell metacharacters.');
  }
}

export function assertValidPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ValidationError('Port must be an integer between 1024 and 65535.');
  }
  return port;
}

export function assertValidHostname(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) {
    throw new ValidationError('Hostname must be 1 to 253 characters.');
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
    throw new ValidationError('Hostname must be a DNS name.');
  }
}

export function assertValidEmail(value) {
  if (typeof value !== 'string' || value.length > 254) throw new ValidationError('Invalid email.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ValidationError('Invalid email.');
}

export function assertPositiveIntInRange(value, min, max, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be an integer between ${min} and ${max}.`);
  }
  return n;
}

/** Validates a WebSocket client envelope. Throws ValidationError with a WS error code. */
export function parseClientEnvelope(rawText, maxBytes) {
  if (rawText.length > maxBytes) {
    throw new ValidationError('Message exceeds the 64 KiB limit.', 'payload_too_large');
  }
  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch {
    throw new ValidationError('Message is not valid JSON.', 'bad_message');
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    throw new ValidationError('Message must be a JSON object.', 'bad_message');
  }
  if (msg.v !== PROTOCOL_VERSION) {
    throw new ValidationError(`Unsupported protocol version. Expected ${PROTOCOL_VERSION}.`, 'bad_message');
  }
  if (!WS_CLIENT_TYPES.includes(msg.type)) {
    throw new ValidationError(`Unknown message type "${String(msg.type)}".`, 'bad_message');
  }
  if (msg.type !== 'ready' && msg.type !== 'takeover') {
    if (typeof msg.sessionId !== 'string' || msg.sessionId.length === 0 || msg.sessionId.length > 128) {
      throw new ValidationError('sessionId must be a non-empty string.', 'bad_message');
    }
  }
  const payload = msg.payload ?? {};
  if (typeof payload !== 'object' || payload === null) {
    throw new ValidationError('payload must be an object.', 'bad_message');
  }
  switch (msg.type) {
    case 'input': {
      if (typeof payload.data !== 'string') throw new ValidationError('payload.data must be a string.', 'bad_message');
      if (payload.data.length > 8192) throw new ValidationError('input chunk too large', 'bad_message');
      break;
    }
    case 'attach':
    case 'takeover': {
      // Client dimensions are optional so older clients that send a bare attach keep working.
      // When present they must be valid, using the same rule as resize.
      assertDims(payload);
      break;
    }
    case 'resize': {
      assertDims(payload, true);
      break;
    }
    default:
      break;
  }
  return msg;
}

/**
 * Validates terminal dimensions. `required` rejects a missing pair (resize); otherwise the pair
 * is optional but must be valid when present (attach, takeover).
 */
function assertDims(payload, required = false) {
  const { cols, rows } = payload;
  if (cols === undefined && rows === undefined) {
    if (required) throw new ValidationError('payload.cols/rows must be integers in 1..1000.', 'bad_message');
    return;
  }
  if (![cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) {
    throw new ValidationError('payload.cols/rows must be integers in 1..1000.', 'bad_message');
  }
}

/** Builds a server envelope. Never includes secrets. */
export function serverEnvelope(type, { sessionId, payload } = {}) {
  const env = { v: PROTOCOL_VERSION, type };
  if (sessionId !== undefined) env.sessionId = sessionId;
  if (payload !== undefined) env.payload = payload;
  return env;
}

export function isServerType(type) {
  return WS_SERVER_TYPES.includes(type);
}

export function isValidAction(action) {
  return SESSION_ACTIONS.includes(action);
}

export function assertBodyNotTooLarge(bytes) {
  if (bytes > HTTP_MAX_BODY_BYTES) {
    throw new ValidationError('Request body too large.', 'payload_too_large');
  }
}

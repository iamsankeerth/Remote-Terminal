export const PROTOCOL_VERSION = 1;

export const WS_PATH = '/ws/terminal';

/** Envelope field limits. See PRD v1.2 section 4.3. */
export const WS_MAX_MESSAGE_BYTES = 64 * 1024;
export const WS_MAX_OUTPUT_BUFFER_BYTES = 1024 * 1024;
export const OUTPUT_CHUNK_MAX_BYTES = 16 * 1024;
export const WS_PING_INTERVAL_MS = 20_000;
export const CONTROL_LEASE_SECONDS = 30;
export const WS_COMPRESSION_DISABLED = true;

/** Resource caps. Setup collects values inside these bounds; no implicit defaults. */
export const SESSION_MIN = 1;
export const SESSION_MAX = 20;
export const CONNECTION_MIN = 1;
export const CONNECTION_MAX = 10;

/** Password policy: 15 to 128 Unicode code points. */
export const PASSWORD_MIN_CODE_POINTS = 15;
export const PASSWORD_MAX_CODE_POINTS = 128;

export const SESSION_LABEL_MIN_CODE_POINTS = 1;
export const SESSION_LABEL_MAX_CODE_POINTS = 64;

/** Argon2id parameters. Stored with each hash so verification can reconstruct them. */
export const ARGON2_PARAMS = Object.freeze({
  algorithm: 'argon2id',
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  tagLength: 32,
});

/** Login Session policy. */
export const LOGIN_SESSION_SLIDING_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_SESSION_COOKIE = 'rt_session';
export const CSRF_COOKIE = 'rt_csrf';
export const LOGIN_RATE_LIMIT = Object.freeze({ attempts: 5, windowMs: 15 * 60 * 1000 });
export const HTTP_MAX_BODY_BYTES = 16 * 1024;

/** tmux namespace. Only sessions in this namespace are managed by the app. */
export const TMUX_NAMESPACE = 'rt1';

export const HTTP_ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  RATE_LIMITED: 'rate_limited',
  ORIGIN_REJECTED: 'origin_rejected',
  SETUP_REQUIRED: 'setup_required',
  CF_UNAUTHORIZED: 'cloudflare_unauthorized',
  INTERNAL: 'internal_error',
});

export const WS_ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'bad_request',
  BAD_MESSAGE: 'bad_message',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  SESSION_NOT_FOUND: 'terminal_session_not_found',
  CONTROL_LEASED: 'control_leased',
  NOT_CONTROLLER: 'not_controller',
  ALREADY_ATTACHED: 'already_attached',
  SESSION_LIMIT: 'terminal_session_limit',
  CONNECTION_LIMIT: 'connection_limit',
  INTERNAL: 'internal_error',
});

export const WS_CLIENT_TYPES = Object.freeze(['attach', 'takeover', 'detach', 'input', 'resize']);

export const WS_SERVER_TYPES = Object.freeze([
  'ready',
  'attached',
  'detached',
  'output',
  'terminal_session_updated',
  'error',
]);

export const SESSION_ACTIONS = Object.freeze(['created', 'renamed', 'terminated', 'exited']);

export const XDG_CONFIG_DIRNAME = 'remote-terminal';
export const XDG_DATA_DIRNAME = 'remote-terminal';

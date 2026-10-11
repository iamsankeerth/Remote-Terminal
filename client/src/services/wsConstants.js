/** Constants shared by reference from @remote-terminal/shared, kept local for the client bundle. */
export const WS_PATH = '/ws/terminal';
export const PROTOCOL_VERSION = 1;
export const WS_CLIENT_TYPES_INPUT = ['attach', 'takeover', 'detach', 'input', 'resize'];
export const WS_MAX_MESSAGE_BYTES = 64 * 1024;
export const CONTROL_LEASE_SECONDS = 30;

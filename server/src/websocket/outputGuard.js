import { WS_MAX_OUTPUT_BUFFER_BYTES } from '@remote-terminal/shared';

/**
 * Slow client protection for PRD v1.2 section 4.6.
 *
 * A browser that stops reading lets the socket queue grow without bound, which would exhaust host
 * memory. The socket's own `bufferedAmount` is the authoritative measure, so when it passes the
 * output buffer limit the gateway pauses forwarding and detaches that client with a recoverable
 * error while tmux keeps running.
 */
export function isClientOverBuffer(ws, limitBytes = WS_MAX_OUTPUT_BUFFER_BYTES) {
  const buffered = ws?.bufferedAmount;
  return typeof buffered === 'number' && buffered > limitBytes;
}

export function outputBufferLimitBytes() {
  return WS_MAX_OUTPUT_BUFFER_BYTES;
}

export default { isClientOverBuffer, outputBufferLimitBytes };

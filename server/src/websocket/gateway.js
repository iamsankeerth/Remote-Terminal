import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
  WS_PATH,
  WS_MAX_MESSAGE_BYTES,
  WS_MAX_OUTPUT_BUFFER_BYTES,
  WS_PING_INTERVAL_MS,
  WS_ERROR_CODES,
  CONTROL_LEASE_SECONDS,
  PROTOCOL_VERSION,
} from '@remote-terminal/shared';
import { parseClientEnvelope, serverEnvelope } from '@remote-terminal/shared';
import { PtyBridge, chunkOutput } from '../terminal/ptyBridge.js';
import { isTunnelRunning, isTunnelOrigin } from '../tunnel/tunnelContext.js';

export function createWebSocketGateway({ server, config, sessions, terminalManager, logger }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const connections = new Map(); // ws -> connection state
  const pendingRemoteChecks = new Set();
  const appContext = { assertionValidator: null };

  terminalManager.broadcast = (message) => {
    const frame = JSON.stringify(serverEnvelope(message.type, { payload: message.payload }));
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(frame);
    }
  };

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }
      // Origin policy: loopback on the configured port, the configured Cloudflare origin, or the
      // live quick tunnel origin when a tunnel is running.
      const origin = req.headers.origin;
      const allowed = await isOriginAllowed(origin, config);
      if (!allowed) {
        logger.warn('ws_origin_rejected', {});
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      if (connections.size >= config.limits.connections) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (error) {
      logger.error('ws_upgrade_error', { errorName: error?.name });
      socket.destroy();
    }
  });

  function isOriginAllowed(origin, cfg) {
    if (origin === undefined) return true; // non-browser clients (tests) on loopback
    if (isTunnelRunning() && isTunnelOrigin(origin)) return true;
    try {
      const url = new URL(origin);
      const host = url.hostname;
      const isLoopback =
        host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
      if (isLoopback && Number(url.port) === Number(cfg.server.port)) return true;
      if (cfg.server.cloudflareOrigin && origin === cfg.server.cloudflareOrigin) return true;
      return false;
    } catch {
      return false;
    }
  }

  wss.on('connection', (ws, req) => {
    const connectionId = randomBytes(9).toString('base64url');
    const state = {
      ws,
      id: connectionId,
      attachedSessionId: null,
      bridge: null,
      bufferedBytes: 0,
      alive: true,
      remote: Boolean(req.headers['cf-ray']),
    };
    connections.set(ws, state);
    logger.info('ws_connected', { connectionHash: shortHash(connectionId), remote: state.remote });

    // Remote requests additionally present a valid Cloudflare Access assertion during upgrade,
    // unless a quick tunnel is serving this process, in which case the application login remains
    // the gate. See docs/adr/0004-quick-tunnel-by-default.md.
    const assertionRequired = appContext.requireAssertion ? appContext.requireAssertion() : true;
    if (state.remote && assertionRequired && config.cloudflare?.aud) {
      // Validation is asynchronous and fail-closed; deny before any protocol traffic.
      // The validator is provided by the app at construction time.
      pendingRemoteChecks.set(ws, true);
      appContext.assertionValidator
        ?.validate(String(req.headers['cf-access-jwt-assertion'] ?? ''))
        .then((result) => {
          if (result.ok) {
            pendingRemoteChecks.delete(ws);
            ws.send(JSON.stringify(serverEnvelope('ready', { payload: { protocolVersion: PROTOCOL_VERSION, connectionId } })));
          } else {
            logger.warn('ws_cloudflare_rejected', { reason: result.reason });
            ws.close(4401, 'access_assertion_rejected');
          }
        })
        .catch(() => ws.close(4401, 'access_assertion_error'));
    } else {
      ws.send(JSON.stringify(serverEnvelope('ready', { payload: { protocolVersion: PROTOCOL_VERSION, connectionId } })));
    }

    const pingTimer = setInterval(() => {
      if (!state.alive) {
        ws.terminate();
        return;
      }
      state.alive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }, WS_PING_INTERVAL_MS);

    ws.on('pong', () => {
      state.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        sendErrorFrame(ws, 'Binary frames are not accepted.', WS_ERROR_CODES.BAD_MESSAGE);
        return;
      }
      let msg;
      try {
        msg = parseClientEnvelope(data.toString('utf8'), WS_MAX_MESSAGE_BYTES);
      } catch (error) {
        sendErrorFrame(ws, error.message, error.code === 'payload_too_large' ? 'payload_too_large' : WS_ERROR_CODES.BAD_MESSAGE);
        return;
      }
      route(ws, state, msg).catch((error) => {
        logger.error('ws_message_error', { errorName: error?.name });
        sendErrorFrame(ws, 'Internal error.', WS_ERROR_CODES.INTERNAL);
      });
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      handleDisconnect(ws, state, 'closed');
    });
    ws.on('error', () => {
      clearInterval(pingTimer);
      handleDisconnect(ws, state, 'error');
    });
  });

  async function route(ws, state, msg) {
    const session = terminalManager.get(msg.sessionId);
    switch (msg.type) {
      case 'attach': {
        if (!session) return sendErrorFrame(ws, 'Terminal session not found.', WS_ERROR_CODES.SESSION_NOT_FOUND);
        if (state.attachedSessionId) {
          return sendErrorFrame(ws, 'Already attached to a session.', WS_ERROR_CODES.ALREADY_ATTACHED);
        }
        attach(ws, state, session, { takeover: false });
        return;
      }
      case 'takeover': {
        if (!msg.sessionId) return sendErrorFrame(ws, 'sessionId required.', WS_ERROR_CODES.BAD_REQUEST);
        if (!session) return sendErrorFrame(ws, 'Terminal session not found.', WS_ERROR_CODES.SESSION_NOT_FOUND);
        if (state.attachedSessionId && state.attachedSessionId !== session.id) {
          return sendErrorFrame(ws, 'Detach before taking over another session.', WS_ERROR_CODES.ALREADY_ATTACHED);
        }
        attach(ws, state, session, { takeover: true });
        return;
      }
      case 'detach': {
        if (!session) return sendErrorFrame(ws, 'Terminal session not found.', WS_ERROR_CODES.SESSION_NOT_FOUND);
        detach(state, { reserved: false });
        return;
      }
      case 'input': {
        if (!session) return sendErrorFrame(ws, 'Terminal session not found.', WS_ERROR_CODES.SESSION_NOT_FOUND);
        if (state.attachedSessionId !== session.id) {
          return sendErrorFrame(ws, 'Not attached to this session.', WS_ERROR_CODES.NOT_CONTROLLER);
        }
        if (session.controllerId !== state.id) {
          return sendErrorFrame(ws, 'Not the controller of this session.', WS_ERROR_CODES.NOT_CONTROLLER);
        }
        state.bridge?.write(msg.payload.data);
        return;
      }
      case 'resize': {
        if (!session) return sendErrorFrame(ws, 'Terminal session not found.', WS_ERROR_CODES.SESSION_NOT_FOUND);
        if (state.attachedSessionId !== session.id) {
          return sendErrorFrame(ws, 'Not attached to this session.', WS_ERROR_CODES.NOT_CONTROLLER);
        }
        state.bridge?.resize({ cols: msg.payload.cols, rows: msg.payload.rows });
        return;
      }
      default:
        sendErrorFrame(ws, 'Unsupported message.', WS_ERROR_CODES.BAD_MESSAGE);
    }
  }

  function attach(ws, state, session, { takeover }) {
    const existing = session.controllerConnectionId;
    if (existing && existing !== state.id) {
      if (!takeover) {
        return sendErrorFrame(ws, 'Another device controls this session.', WS_ERROR_CODES.CONTROL_LEASED);
      }
      if (session.leaseUntil > Date.now()) {
        return sendErrorFrame(ws, 'Control is still leased to the previous device.', WS_ERROR_CODES.CONTROL_LEASED);
      }
      // Detach the previous controller's bridge so only one tmux client drives the session.
      const other = findConnectionById(existing);
      if (other) {
        other.state.bridge?.detach();
        other.state.bridge = null;
        other.state.attachedSessionId = null;
        sendFrame(other.ws, 'detached', { reason: 'taken_over' });
      }
    }

    const cols = 80;
    const rows = 24;
    const { file, args } = terminalManager.tmux.attachArgs({ id: session.id, cols, rows });
    state.bufferedBytes = 0;
    const bridge = new PtyBridge({
      file,
      args,
      cols,
      rows,
      cwd: terminalManager.homeDir,
      onData: (data) => {
        state.bufferedBytes += Buffer.byteLength(data, 'utf8');
        if (state.bufferedBytes > WS_MAX_OUTPUT_BUFFER_BYTES) {
          // Slow client protection: pause forwarding, detach with a recoverable error, tmux runs on.
          state.bridge?.pause();
          detach(state, { reserved: true, recoverable: true });
          sendErrorFrame(ws, 'Output buffer exceeded. Detached to protect the host.', WS_ERROR_CODES.NOT_CONTROLLER);
          return;
        }
        for (const chunk of chunkOutput(data)) {
          if (ws.readyState !== 1) return;
          ws.send(JSON.stringify(serverEnvelope('output', { sessionId: session.id, payload: { data: chunk } })));
        }
        state.bufferedBytes = 0;
      },
      onExit: ({ exitCode, signal, error, detached }) => {
        state.bridge = null;
        state.attachedSessionId = null;
        session.controller = null;
        session.controllerId = null;
        session.controllerConnectionId = null;
        if (error) {
          sendFrame(ws, 'detached', { reason: 'pty_error' });
        } else if (detached) {
          // We detached this tmux client ourselves. The Terminal Session keeps running.
          sendFrame(ws, 'detached', { reason: 'released' });
        } else {
          // The shell inside tmux exited, which ends the Terminal Session.
          sendFrame(ws, 'detached', { reason: 'shell_exited' });
          terminalManager.handleNaturalExit(session.id);
        }
      },
    });
    state.bridge = bridge;
    state.attachedSessionId = session.id;
    session.controller = state.id;
    session.controllerId = state.id;
    session.controllerConnectionId = state.id;
    session.leaseUntil = 0;

    // Confirm the attachment immediately. The captured viewport is then delivered as ordinary
    // output, so the handshake never waits on a tmux exec and a slow capture cannot stall it.
    // Restoration covers the current pane viewport only, never historical scrollback.
    sendFrame(
      ws,
      'attached',
      { sessionId: session.id, cols, rows, controllerConnectionId: state.id },
      session.id,
    );
    terminalManager.tmux.captureVisible(session.id).then((snapshot) => {
      if (snapshot) sendFrame(ws, 'output', { data: snapshot }, session.id);
    });

    logger.info('terminal_session_attached', {
      connectionHash: shortHash(state.id),
      sessionIdHash: shortHash(session.id),
      takeover: Boolean(takeover),
    });
  }

  function detach(state, { reserved, recoverable = false }) {
    const session = state.attachedSessionId ? terminalManager.get(state.attachedSessionId) : null;
    state.bridge?.detach();
    state.bridge = null;
    const previous = state.attachedSessionId;
    state.attachedSessionId = null;
    if (session) {
      if (reserved) {
        // Unexpected disconnect or protective detach: reserve control for this client.
        session.leaseUntil = Date.now() + CONTROL_LEASE_SECONDS * 1000;
      } else {
        session.controller = null;
        session.controllerId = null;
        session.controllerConnectionId = null;
        session.leaseUntil = 0;
      }
    }
    if (previous && state.ws?.readyState === 1) {
      sendFrame(state.ws, 'detached', {
        sessionId: previous,
        reason: reserved ? 'reserved' : 'clean',
        recoverable,
      });
    }
  }

  function handleDisconnect(ws, state, reason) {
    connections.delete(ws);
    if (state.attachedSessionId) {
      const session = terminalManager.get(state.attachedSessionId);
      state.bridge?.detach();
      state.bridge = null;
      if (session) {
          if (reason === 'closed' || reason === 'error') {
          session.leaseUntil = Date.now() + CONTROL_LEASE_SECONDS * 1000;
          session.controllerConnectionId = state.id;
        } else {
          session.controller = null;
          session.controllerId = null;
          session.controllerConnectionId = null;
        }
      }
      state.attachedSessionId = null;
    }
    logger.info('ws_disconnected', { connectionHash: shortHash(state.id), reason });
  }

  function findConnectionById(id) {
    for (const [ws, state] of connections) {
      if (state.id === id) return { ws, state };
    }
    return null;
  }

  function sendFrame(ws, type, payload, sessionId) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(serverEnvelope(type, { sessionId, payload })));
    } catch {
      /* ignore */
    }
  }

  function sendErrorFrame(ws, message, code = WS_ERROR_CODES.BAD_REQUEST) {
    sendFrame(ws, 'error', { code, message }, undefined);
  }

  return {
    wss,
    appContext,
    shortHash,
    close() {
      for (const [ws, state] of connections) {
        state.bridge?.detach();
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
      connections.clear();
      wss.close();
    },
  };
}

function shortHash(value) {
  return randomBytes(4).toString('hex') + '-' + String(value).length;
}

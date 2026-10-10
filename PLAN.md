# Remote Terminal PRD v1.2 and MVP Implementation

## Summary

Create a new v1.2 specification while preserving Remote_Terminal_PRD_v1.1_bcrypt.md. The revised product is a personal, self-hosted remote terminal for one owner, running entirely inside native Linux or Ubuntu on WSL2.

The grill-with-docs review established precise domain terms, removed conflicting requirements, and identified three architectural decisions worth recording as ADRs.

## Documentation and Architecture

- Create Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md.
- Add a glossary-only CONTEXT.md defining Owner, Host Environment, Terminal Session, Login Session, Browser Connection, Controller, Attachment, Detach, Takeover, and Terminate, including an example dialogue.
- Add three concise ADRs under docs/adr/:
  1. One Linux runtime for native Linux and WSL2.
  2. Cloudflare Tunnel + Access + application login.
  3. Node-native Argon2id instead of bcrypt.
- State explicitly that native Windows Node, PowerShell/CMD terminals, existing external tmux sessions, multi-user access, databases, PWA, voice input, auto-start services, and full output-history persistence are outside MVP scope.
- Require Node.js 24.7+ LTS, which provides asynchronous native Argon2id without another native dependency. Node.js release status, Node.js Argon2 API.
- Use npm workspaces with JavaScript ESM packages for client, server, and shared.

## Product Behavior and Interfaces

### Setup, authentication, and ingress

- Provide a local interactive setup CLI with no /api/setup route. It must:
  - Validate Node, tmux, node-pty build prerequisites, non-root execution, and WSL2 when applicable.
  - Collect the owner username, password, Cloudflare hostname/team domain/AUD/owner email, server port, and required resource caps.
  - Accept 1–20 Terminal Sessions and 1–10 active Browser Connections, with no implicit defaults.
  - Never install packages, elevate privileges, or configure Cloudflare.
- Enforce passwords of 15–128 Unicode code points, accept spaces and printable Unicode, and impose no composition or periodic-rotation rule, following current password guidance. NIST password requirements.
- Hash with asynchronous Node-native Argon2id using a random 16-byte salt and stored algorithm parameters. Compare derived keys using constant-time comparison.
- Bind only to Linux loopback. On Windows, Node, tmux, node-pty, and cloudflared all run inside the same WSL2 distro.
- Treat Cloudflare provisioning as a documented manual prerequisite. Require Cloudflare Tunnel, Cloudflare Access, one exact public HTTPS origin, and one pinned Access email.
- Validate Cf-Access-Jwt-Assertion cryptographically using the configured issuer, audience, expiry, token type, and email; cache Cloudflare JWKS with fail-closed remote behavior. Cloudflare recommends validating this assertion header rather than relying on the cookie. Cloudflare JWT validation.
- Allow only localhost origins and the configured Cloudflare origin. Reject all other HTTP mutations and WebSocket upgrades.
- Store opaque Login Sessions in memory. Use host-only, HTTP-only, SameSite=Strict cookies with a 30-day sliding lifetime; restart revokes all sessions.
- Logout revokes the current device only. Local CLI password changes and global revocation signal the running process and revoke every Login Session.
- Remote WebSockets close at the Access JWT expiry and reconnect through Cloudflare. Cloudflare may also terminate sockets during edge updates, so automatic recovery is mandatory. Cloudflare WebSocket behavior.

### Terminal lifecycle

- Expose only app-created tmux sessions, identified internally by an instance namespace plus opaque random ID.
- Start each session in the Linux user’s home directory using their validated login shell and privileges.
- Use unique, case-insensitive display labels of 1–64 Unicode code points, initially Terminal 1, Terminal 2, and so on. Never interpolate labels into shell or tmux commands.
- Rediscover namespaced tmux sessions after Node restarts and reconcile them with atomically written JSON metadata.
- Guarantee persistence across browser disconnects, tab changes, Cloudflare interruptions, and Node restarts. Do not promise survival across Linux reboot, WSL shutdown, or host shutdown.
- Guarantee restoration of the current tmux pane viewport only, not historical scrollback.
- Permit one Controller per Terminal Session and one attached Terminal Session per Browser Connection:
  - Switching tabs detaches the previous tmux client without stopping its command.
  - A second device must explicitly confirm takeover.
  - Unexpected disconnects reserve control for the same browser client for 30 seconds.
  - Any owner device may terminate a controlled session after a stronger named warning.
- A natural shell exit removes the Terminal Session. Explicit termination requires a named confirmation and broadcasts the result to all browsers.
- If an output buffer exceeds 1 MiB, detach the slow browser with a recoverable error while leaving tmux running.
- Use @xterm/xterm with the fit addon, one retained xterm instance per tab, responsive dark UI, and a mobile special-key toolbar. Official xterm.js package guidance.
- Store only client preferences—font size, scrollback size, and toolbar visibility—in browser local storage. Never store authentication tokens there.

### HTTP and WebSocket contracts

- HTTP API:
  - POST /api/auth/login
  - POST /api/auth/logout
  - GET /api/auth/me
  - GET /api/sessions
  - POST /api/sessions
  - PATCH /api/sessions/:id
  - DELETE /api/sessions/:id
  - GET /api/system/status
- Remove setup, server-settings, and HTTP-detach endpoints. Detachment belongs to the WebSocket lifecycle.
- Mutating HTTP requests require a session-bound CSRF token and exact Origin validation. Limit request bodies and return a common { error: { code, message, details? } } shape.
- Use /ws/terminal with versioned JSON envelopes:
  - Client: attach, takeover, detach, input, resize.
  - Server: ready, attached, detached, output, terminal_session_updated, error.
- Authenticate during upgrade using both the Login Session and, remotely, the Cloudflare assertion. Use WebSocket ping/pong control frames, a 64 KiB incoming-message limit, disabled compression, strict schemas, and bounded output chunks.
- Reconnect with jittered exponential backoff, restore the session list, and reattach the previously selected Terminal Session without creating another tmux session.

## Test and Acceptance Plan

- Unit-test setup validation, configuration permissions and atomic writes, Unicode password rules, Argon2id hashing, Login Session lifecycle, CSRF/origin checks, rate limiting, Cloudflare JWT claims, message schemas, display-name uniqueness, and resource caps.
- Integration-test real tmux/node-pty behavior: create, input/output, ANSI rendering, resize, detach, current-screen recovery, takeover, 30-second lease, natural exit, explicit termination, slow-client detachment, Node restart, and metadata reconciliation.
- Security-test missing/invalid/expired Access assertions, wrong owner email, unauthorized IDs, malformed and oversized messages, hostile labels, path traversal, CSRF, login throttling, cookie attributes, secret-free logs, and WebSocket expiry.
- Run Playwright workflows for desktop Chromium and Android viewports; perform a real Android Chrome smoke test covering keyboard, touch toolbar, rotation, reconnect, and takeover.
- Gate release on Windows 11 + Ubuntu WSL2 and native Ubuntu 24.04 LTS. Other distros remain explicitly unverified.
- Run a real Cloudflare staging smoke test for HTTPS/WSS, Access enforcement, JWT renewal, email pinning, origin rejection, and reconnect after forced socket closure.
- Require under 150 ms P95 for a simple local terminal echo on both reference hosts. Measure and report Cloudflare remote latency without imposing a universal internet SLA.
- Log structured operational metadata only to stdout/stderr; never log passwords, commands, keystrokes, terminal output, cookies, Login Session tokens, or Access JWTs.

## Assumptions and Defaults

- One owner, one Host Environment, multiple owner devices, and app-managed Terminal Sessions only.
- Foreground CLI startup only; Node and separately started cloudflared must both remain running for remote access.
- JSON configuration and metadata use XDG directories with 0700 directories, 0600 files, schema versioning, and atomic replacement.
- No migration from bcrypt is needed because no implementation or stored credentials currently exist.
- Cloudflare Access should use a 24-hour application policy session; application Login Sessions remain independently governed by logout, 30-day sliding cookies, and backend restart.

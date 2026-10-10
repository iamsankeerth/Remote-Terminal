# PRODUCT REQUIREMENTS DOCUMENT

# Remote Terminal Access & Management Platform

**Document Version:** 1.2\
**Supersedes:** `Remote_Terminal_PRD_v1.1_bcrypt.md` on security and hosting decisions\
**Project Category:** Full-Stack Web Application / Developer Tools\
**Development Language:** JavaScript (ESM, no TypeScript)\
**Frontend:** React + `@xterm/xterm` (+ fit addon)\
**Backend:** Node.js 24.7+ LTS native `http` + `ws` + `node-pty` + `crypto`\
**Terminal Persistence:** tmux (application-managed sessions only)\
**Remote Ingress:** Cloudflare Tunnel + Cloudflare Access + application login\
**Project Type:** Real-Time Remote Terminal Management for a single owner

---

## 1. Executive Summary

Remote Terminal gives one owner browser-based access to terminal sessions running on their own
host machine. The owner can attach to, control, detach from, take over, and terminate terminal
sessions from any of their own devices, including phones and tablets.

The application runs **entirely inside native Linux or Ubuntu on WSL2**. It binds to loopback
only. Remote access is provided by Cloudflare Tunnel and Cloudflare Access, with the owner
additionally authenticating into the application itself.

The engineering focus is the browser ↔ Node.js ↔ operating system path: keeping real terminal
processes alive and correctly re-connected across browser refreshes, network changes, Cloudflare
socket churn, and server restarts. No database is used.

### 1.1 What changed from v1.1

| Decision | v1.1 | v1.2 (this document) |
| --- | --- | --- |
| Password hashing | bcrypt, cost 12 | Node-native asynchronous **Argon2id**, random 16-byte salt, constant-time comparison |
| Host runtime | Linux / macOS / Windows with or without WSL | Native Linux or **Ubuntu on WSL2 only** |
| Remote access | Tailscale Serve style private networking | **Cloudflare Tunnel + Access + app login** |
| Setup | `POST /api/setup` route | **Local interactive CLI only, no HTTP setup route** |
| External tmux sessions | Mirror existing tmux sessions | **App-managed sessions only** |
| Packages | bcrypt | None added for hashing (Node 24.7+ `crypto.argon2`) |
| Voice / PWA | P1 post-MVP | **Out of MVP scope** |

### 1.2 Runtime prerequisite

Node.js **24.7.0 or newer LTS** is required because it provides the asynchronous native Argon2id
implementation (`crypto.argon2`) without an additional native dependency. Older Node versions,
including Node 22, do not satisfy this requirement.

---

## 2. Scope

### 2.1 In scope (MVP)

- One owner, one Host Environment, multiple owner devices
- Interactive setup CLI that configures the owner account and validates the host
- Argon2id password hashing and application login with in-memory Login Sessions
- Cloudflare Tunnel + Access protected remote ingress with cryptographic JWT validation
- Application-managed tmux Terminal Sessions (create, rename, attach, detach, takeover, terminate)
- Persistence across browser disconnects, tab changes, Cloudflare socket termination, and Node
  restarts; restoration of the current pane viewport only
- React client with xterm.js, session tabs, responsive dark UI, and a mobile special-key toolbar
- Automatic reconnection with jittered exponential backoff
- JSON configuration and metadata in XDG directories with atomic writes
- Unit, integration, security, and Playwright browser tests
- Structured logging of operational metadata only

### 2.2 Out of scope (MVP)

- Native Windows Node.js runtime (Windows access is via Ubuntu on WSL2)
- PowerShell / CMD terminals
- Creating, mirroring, or managing tmux sessions the application did not create
- Multi-user access, sharing, or role separation
- Databases of any kind
- PWA installation, service workers, offline mode
- Voice input
- Auto-start services, systemd units, launchd, boot persistence
- Full output-history persistence and scrollback replay beyond the live pane
- Automated Cloudflare account, tunnel, DNS, or Access provisioning

---

## 3. Definitions

Domain terms are defined in `CONTEXT.md` and are authoritative. Terms used in this document
include Owner, Host Environment, Terminal Session, Login Session, Browser Connection, Controller,
Attachment, Detach, Takeover, and Terminate. When this document and `CONTEXT.md` disagree,
`CONTEXT.md` wins on vocabulary; this document wins on behavior.

---

## 4. Product Behavior

### 4.1 Setup, authentication, and ingress

- Setup is a **local interactive CLI**. There is no `/api/setup` HTTP route and no browser
  onboarding flow.
- The setup CLI validates, before writing anything:
  - Node.js is 24.7.0 or newer.
  - `tmux` exists and is a supported version.
  - `node-pty` build prerequisites are present (compiler toolchain and Python 3).
  - The process is **not running as root**.
  - When invoked from Windows, the Node process, tmux, `node-pty`, and `cloudflared` all run
    inside the same WSL2 distro.
- The setup CLI collects, with **no implicit defaults**:
  - Owner username.
  - Owner password (see §6.1).
  - Cloudflare hostname, team domain, Access Application Audience (AUD), and owner email.
  - Server port.
  - Resource caps: 1–20 Terminal Sessions, 1–10 active Browser Connections.
- The setup CLI never installs packages, elevates privileges, or configures Cloudflare.
  Cloudflare provisioning is a documented manual prerequisite performed by the Owner.

### 4.2 HTTP API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/auth/login` | Authenticate the Owner |
| POST | `/api/auth/logout` | Revoke the current device only |
| GET | `/api/auth/me` | Current Login Session information |
| GET | `/api/sessions` | List Terminal Sessions |
| POST | `/api/sessions` | Create a Terminal Session |
| PATCH | `/api/sessions/:id` | Rename a Terminal Session |
| DELETE | `/api/sessions/:id` | Terminate a Terminal Session |
| GET | `/api/system/status` | Host and server status |

There are no setup, server-settings, or HTTP-detach endpoints. Detachment belongs to the
WebSocket lifecycle.

Every mutating HTTP request requires:

- A session-bound CSRF token.
- Exact Origin validation. Only localhost origins and the configured Cloudflare origin are
  accepted; all others are rejected.
- Bounded request body size.

Error responses use one shape:

```json
{ "error": { "code": "machine_readable_code", "message": "human message", "details": {} } }
```

### 4.3 WebSocket protocol (`/ws/terminal`)

Messages are JSON with a versioned envelope: `{ v, type, sessionId?, payload }`. Unrecognized
versions, unknown types, and malformed payloads are rejected without closing the connection
unless the connection is abusive.

Client → server:

| Type | Purpose |
| --- | --- |
| `attach` | Attach to a Terminal Session |
| `takeover` | Explicitly take control from another device |
| `detach` | Detach from the attached Terminal Session |
| `input` | Send input bytes as text |
| `resize` | Resize the terminal (`cols`, `rows`) |

Server → client:

| Type | Purpose |
| --- | --- |
| `ready` | Upgrade accepted, protocol negotiated |
| `attached` | Attachment confirmed |
| `detached` | Detachment confirmed |
| `output` | Terminal output chunk |
| `terminal_session_updated` | Session created, renamed, or terminated |
| `error` | Recoverable or terminal error |

Transport rules:

- Authentication is validated **during upgrade** using the Login Session and, for remote
  connections, the Cloudflare Access JWT assertion.
- Incoming messages are limited to 64 KiB. Compression is disabled.
- WebSocket ping/pong control frames detect dead peers.
- Output chunks are bounded.
- Reconnect uses jittered exponential backoff, restores the session list, and reattaches the
  previously selected Terminal Session **without creating another tmux session**.

### 4.4 Terminal Session lifecycle

- The application owns only tmux sessions in its own instance namespace, identified internally by
  the namespace plus an opaque random ID. External tmux sessions are never created, mirrored, or
  managed.
- Each session starts in the Linux user's home directory using their validated login shell and
  privileges.
- Display labels are unique, case-insensitive, 1–64 Unicode code points, initially `Terminal 1`,
  `Terminal 2`, and so on. Labels are never interpolated into shell or tmux commands; tmux
  targets always use the internal namespaced identifier.
- After a Node restart, namespaced tmux sessions are rediscovered and reconciled with atomically
  written JSON metadata.
- Persistence is guaranteed across browser disconnects, tab changes, Cloudflare interruptions,
  and Node restarts. Persistence across Linux reboot, WSL shutdown, or host shutdown is **not**
  promised.
- Restoration restores the current tmux pane viewport only, not historical scrollback.

### 4.5 Control and takeover semantics

Exactly one Controller per Terminal Session, and exactly one attached Terminal Session per
Browser Connection.

- Switching tabs detaches the previous tmux client without stopping its command.
- A second device must explicitly confirm Takeover.
- An unexpected disconnect reserves control for the same browser client for 30 seconds.
- Any owner device may Terminate a controlled session after a stronger named warning.

### 4.6 Termination and removal

- A natural shell exit removes the Terminal Session.
- Explicit Terminate requires a named confirmation and broadcasts the result to all browsers.
- If an output buffer exceeds 1 MiB, the slow browser is detached with a recoverable error while
  tmux keeps running.

---

## 5. User Experience

### 5.1 Design principles

Developer-focused, minimal clutter, fast terminal access, responsive layouts, clear connection
feedback, consistent session controls, keyboard and touch accessible, dark theme by default.

### 5.2 Screens

1. **Login** — username, password, show/hide, submit, error, server availability indicator.
2. **Terminal workspace** — header, connection indicator, session tabs, new session button,
   terminal display, mobile special-key toolbar, session actions menu, preferences, logout.
3. **Session manager** — list with names, creation times, attached state, and attach/rename/
   detach/terminate actions. Terminate requires confirmation.
4. **Connection recovery** — connection state, reconnecting indicator, manual retry,
   authentication-expired and server-unavailable notices.

### 5.3 Browser Connection states

Connected, Connecting, Reconnecting, Disconnected, Authentication expired, Server unavailable.

---

## 6. Security Requirements

### 6.1 Password rules

- 15–128 Unicode code points.
- Spaces and printable Unicode accepted.
- No composition rules. No periodic rotation requirement.

### 6.2 Password storage

- Argon2id via Node's asynchronous native implementation with a random 16-byte salt.
- Algorithm parameters are stored with the hash.
- Derived keys are compared in constant time.
- Local CLI password changes and global revocation signal the running process and revoke every
  Login Session.

### 6.3 Login Sessions

- Opaque, in-memory only. Not persisted, not stored in browser local storage.
- Cookies are host-only, HTTP-only, `SameSite=Strict`, with a 30-day sliding lifetime.
- A server restart revokes all Login Sessions.
- Logout revokes the current device only.

### 6.4 Network

- Loopback binding only. There is no public listener besides Cloudflare's tunnel.
- Only localhost origins and the configured Cloudflare origin are accepted for HTTP mutations and
  WebSocket upgrades.
- Remote WebSockets close at Access JWT expiry and reconnect through Cloudflare. Cloudflare may
  also terminate sockets during edge updates, so automatic recovery is mandatory.
- No credentials, tokens, or JWTs in URLs, query strings, or logs.

### 6.5 Cloudflare Access validation

- `Cf-Access-Jwt-Assertion` is validated cryptographically, not trusted:
  - issuer, audience, expiry, token type, and pinned owner email are all checked.
  - The Cloudflare JWKS is cached, with fail-closed behavior when remote fetch fails.
- A missing, invalid, expired, or wrong-email assertion denies the request.

### 6.6 Terminal and input safety

- Shell processes run only with the operating-system privileges of the configured host account.
- Non-root execution is enforced at setup.
- Server-side ownership is checked before any input, resize, takeover, or terminate.
- Session identifiers are opaque; session ownership is validated on every operation.
- Session counts and Browser Connection counts are capped (1–20 and 1–10, configurable at setup).
- Message and output-buffer sizes are bounded.
- User-provided strings are never interpolated into shell or tmux command construction.
- Structured logs contain operational metadata only. Passwords, commands, keystrokes, terminal
  output, cookies, Login Session tokens, and Access JWTs are never logged.

---

## 7. Client Requirements

- React functional components and hooks. No global state library.
- `@xterm/xterm` with the fit addon; one retained xterm instance per tab; switching tabs must not
  destroy and recreate terminal instances.
- Responsive dark UI working on desktop, tablet, and mobile; works with the mobile keyboard open.
- Mobile special-key toolbar: Esc, Tab, Ctrl, Alt, Enter, Backspace, arrows, Pipe, Slash, Tilde.
  Ctrl and Alt combine with other keys; the toolbar collapses.
- Browser local storage stores client preferences only — font size, scrollback size, toolbar
  visibility. Authentication tokens are never stored there.
- Reconnection preserves interface state and session selection.

---

## 8. Backend Requirements

### 8.1 HTTP server

Native Node.js `http`. Serves the built React application and the JSON API in §4.2. No Express,
Fastify, NestJS, or any web framework.

### 8.2 WebSocket server

`ws` at `/ws/terminal` per §4.3.

### 8.3 Terminal manager

`node-pty` plus tmux per §4.4 and §4.5. The ptys are tmux clients; tmux owns process lifetime.

### 8.4 Authentication manager

Node `crypto` for Argon2id hashing and verification, random session ID generation, and
constant-time comparison. Login Sessions are held in memory.

### 8.5 Configuration manager

Node `fs` with XDG directories:

- 0700 directories, 0600 files.
- Schema versioning.
- Atomic replacement (write temp file in the same directory, then rename).
- JSON only: owner username, Argon2id parameters and hash, non-sensitive server configuration,
  Terminal Session display metadata.

---

## 9. Project Layout

npm workspaces with JavaScript ESM packages.

```
.
├── AGENTS.md
├── PLAN.md
├── CONTEXT.md
├── README.md
├── package.json                # workspaces: client, server, shared
├── client/                     # React + Vite + xterm.js
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   └── src/
│       ├── components/
│       ├── hooks/
│       ├── services/
│       ├── styles/
│       ├── App.jsx
│       └── main.jsx
├── server/                     # native Node.js
│   ├── package.json
│   ├── src/
│   │   ├── index.js
│   │   ├── httpServer.js
│   │   ├── websocketServer.js
│   │   ├── auth/
│   │   ├── terminal/
│   │   ├── routes/
│   │   └── utils/
│   └── tests/
├── shared/                     # protocol, constants, schemas
│   ├── package.json
│   ├── protocol.js
│   └── constants.js
└── docs/
    ├── adr/
    └── setup.md                # Cloudflare manual prerequisites
```

---

## 10. Test and Acceptance Plan

### 10.1 Unit tests

Node's built-in test runner (`node:test`). Cover: setup validation (Node version, tmux, non-root,
WSL2 detection), configuration permissions and atomic writes, Unicode password rules, Argon2id
hashing and constant-time comparison, Login Session lifecycle, CSRF/Origin checks, rate limiting,
Cloudflare JWT claims, message schemas, display-label uniqueness, and resource caps.

### 10.2 Integration tests

Run against real tmux and `node-pty`. Cover: create, input/output, ANSI rendering, resize, detach,
current-screen recovery, takeover, the 30-second control lease, natural exit, explicit termination,
slow-client detachment, Node restart, and metadata reconciliation.

### 10.3 Security tests

Missing, invalid, expired, and wrong-email Cloudflare assertions; unauthorized session IDs;
malformed and oversized messages; hostile display labels; path traversal in configuration; CSRF;
login throttling; cookie attributes; secret-free logs; WebSocket expiry.

### 10.4 Browser tests

Playwright workflows for desktop Chromium and an Android viewport, including keyboard, touch
toolbar, rotation, reconnect, and takeover. A real Android Chrome smoke test is required before
the MVP is claimed mobile-capable.

### 10.5 Release gates

- Windows 11 + Ubuntu on WSL2.
- Native Ubuntu 24.04 LTS.
- Other distributions remain explicitly unverified.
- A real Cloudflare staging smoke test covering HTTPS/WSS, Access enforcement, JWT renewal, email
  pinning, origin rejection, and reconnect after forced socket closure.
- Under 150 ms P95 for a simple local terminal echo on both reference hosts. Cloudflare remote
  latency is measured and reported without imposing a universal internet SLA.

---

## 11. Non-functional Targets

- Terminal interaction feels immediate; see the P95 target in §10.5.
- At least five simultaneous Terminal Sessions on the reference host.
- Bounded memory: capped sessions, capped connections, capped message size, capped output buffer.
- Failure in one Terminal Session does not affect unrelated sessions.
- All product decisions live in `PLAN.md`, `CONTEXT.md`, or `docs/adr/`, and are kept in sync when
  behavior changes.

---

## 12. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Unauthorized remote shell access | Critical | Argon2id login, Cloudflare Access with cryptographic JWT validation, pinned email, strict Origin, loopback-only bind |
| Accidental termination | High | Separate Detach and Terminate, named confirmations, broadcast results |
| Cloudflare socket churn | Medium | Mandatory reconnection with jittered backoff and reattach without duplication |
| Slow client memory growth | Medium | 1 MiB output buffer detaches the slow browser while tmux survives |
| Host shutdown | Medium | Documented as out of scope; not promised |
| Sensitive data exposure | High | Secret-free structured logs, no keystroke/output logging, restricted file permissions |
| Older Node runtime | Medium | Setup validates Node 24.7+ before any configuration write |

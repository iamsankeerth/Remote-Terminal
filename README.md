# Remote Terminal

A personal, self-hosted, browser-based remote terminal for one owner. Attach to, control, detach
from, take over, and terminate terminal sessions running on your own host machine, from any of
your devices.

- **Runtime:** Node.js 24.7+ LTS inside native Linux or Ubuntu on WSL2
- **Persistence:** tmux, application-managed sessions only
- **Remote access:** Cloudflare Tunnel + Cloudflare Access + application login
- **Passwords:** Node-native Argon2id (no bcrypt, no database, no web framework)
- **Frontend:** React + `@xterm/xterm`

Authoritative documents:

- `PLAN.md` — implementation direction
- `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` — behavior specification
- `CONTEXT.md` — domain vocabulary
- `docs/adr/` — architecture decisions
- `docs/setup.md` — Cloudflare manual prerequisites and host setup

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | 24.7.0 or newer LTS |
| tmux | 3.x |
| C toolchain + Python 3 | for building `node-pty` |
| OS | Ubuntu 24.04 LTS (native or WSL2) or another native Linux |

## Install

```bash
# Inside Ubuntu on WSL2 or native Linux
nvm install 24
sudo apt-get update && sudo apt-get install -y tmux build-essential python3
npm install
```

## Setup

Setup is a local interactive CLI. It validates the host, then collects the owner account,
Cloudflare ingress values, and resource caps. It never installs packages, escalates privileges,
or changes your Cloudflare account.

```bash
npm run setup
```

Cloudflare Tunnel and Access provisioning is a **manual prerequisite** documented in
`docs/setup.md`.

## Run

```bash
npm run build     # build the React client into client/dist
npm start         # binds 127.0.0.1 on the port you chose during setup
```

Then open `http://127.0.0.1:<port>` on the same machine, or your Cloudflare hostname remotely.

## Test

```bash
npm test              # unit and integration (node --test)
npm run test:e2e      # Playwright browser workflows (requires a running server)
```

## Security posture

- Loopback binding only; Cloudflare provides the only remote ingress.
- Argon2id hashing with random 16-byte salts and constant-time comparison.
- Passwords are 15–128 Unicode code points.
- Strict Origin and CSRF validation on every HTTP mutation and WebSocket upgrade.
- Cloudflare `Cf-Access-Jwt-Assertion` is validated cryptographically with a cached JWKS and
  fail-closed behavior.
- Login Sessions are opaque and in-memory, in host-only, HTTP-only, `SameSite=Strict` cookies
  with a 30-day sliding lifetime. A restart revokes all sessions.
- Configuration lives in XDG directories as 0700/0600 JSON written atomically.
- Structured logs contain operational metadata only — never passwords, keystrokes, terminal
  output, cookies, tokens, or JWTs.

## Repository layout

```
client/    React + xterm.js front end
server/    native Node.js HTTP + WebSocket + tmux
shared/    protocol, constants, and validation shared by both
docs/      ADRs and setup documentation
```

## License

UNLICENSED. This is a personal project for a single owner.

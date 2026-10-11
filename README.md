# Remote Terminal

A personal, self-hosted, browser-based remote terminal for one owner. Attach to, control, detach
from, take over, and terminate terminal sessions running on your own host machine, from any of
your devices.

- **Runtime:** Node.js 24.7+ LTS inside native Linux or Ubuntu on WSL2
- **Persistence:** tmux, application-managed sessions only
- **Remote access:** Cloudflare quick tunnel, deployed by default. No Cloudflare account needed.
- **Passwords:** Node-native Argon2id (no bcrypt, no database, no web framework)
- **Frontend:** React + `@xterm/xterm`

Authoritative documents:

- `PLAN.md` — implementation direction
- `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` — behavior specification
- `CONTEXT.md` — domain vocabulary
- `docs/adr/` — architecture decisions
- `docs/setup.md` — host prerequisites, quick tunnel, and optional named-tunnel setup

## Access from your phone (the default path)

```bash
# Inside Ubuntu on WSL2
cd "/mnt/c/Users/lenovo/Desktop/San/Fun_Projects/Remote Terminal"
npm start
```

The server prints:

```
  Phone URL: https://calm-words-1234.trycloudflare.com
  Open it on any device and sign in with your owner username and password.
  This URL is temporary and changes every time the server restarts.
  Anyone with this URL can reach the login screen: use a strong password.
```

Open that URL on your phone, sign in with your owner username and password, and the terminal
appears. It takes a few seconds for the URL to become reachable after startup.

Notes:

- The URL changes every time the server restarts, because it is a Cloudflare quick tunnel.
- Remote access is protected by the application login, CSRF, and strict Origin checks. There is no
  Cloudflare Access layer on a quick tunnel; see `docs/adr/0004-quick-tunnel-by-default.md`.
- `tmux` sessions survive a restart, so a restart only changes the URL.
- Disable the tunnel with `npm start -- --no-tunnel` (loopback only).

## Requirements

| Requirement | Version |
| --- | --- |
| Node.js | 24.7.0 or newer LTS |
| tmux | 3.x |
| C toolchain + Python 3 | for building `node-pty` |
| cloudflared | any recent build, used for remote access |
| OS | Ubuntu 24.04 LTS (native or WSL2) or another native Linux |

## Install

```bash
# Inside Ubuntu on WSL2 or native Linux
nvm install 24
sudo apt-get update && sudo apt-get install -y tmux build-essential python3

# cloudflared for remote access (installed into ~/.local/bin; no sudo required)
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared

cd "/mnt/c/Users/lenovo/Desktop/San/Fun_Projects/Remote Terminal"
npm install
```

## Setup

Setup is a local interactive CLI. There is no HTTP setup route.

```bash
npm run setup
```

It validates the host (Node version, tmux, `node-pty` build prerequisites, non-root, WSL2), then
asks for your username, password (15+ characters, hidden input), port, whether to use the quick
tunnel, and the session and connection limits. Answering **yes** to the quick tunnel question
skips every Cloudflare prompt.

## Test

```bash
npm test              # unit and integration (node --test)
npm run test:e2e      # Playwright browser workflows (requires a running server)
```

## Security posture

- Loopback binding only; `cloudflared` dials outbound, so no port is ever opened.
- Argon2id hashing with a random 16-byte salt and constant-time comparison.
- Passwords are 15–128 Unicode code points.
- Strict Origin and CSRF validation on every mutation and WebSocket upgrade.
- Login Sessions are opaque and in-memory, in host-only, HTTP-only, `SameSite=Strict` cookies with
  a 30-day sliding lifetime. A restart revokes all sessions.
- Configuration lives in XDG directories as 0700/0600 JSON written atomically.
- Structured logs contain operational metadata only — never passwords, keystrokes, terminal
  output, cookies, tokens, or JWTs.

## Repository layout

```
client/    React + xterm.js front end
server/    native Node.js HTTP + WebSocket + tmux + Cloudflare tunnel
shared/    protocol, constants, and validation shared by both
docs/      ADRs and setup documentation
```

## License

UNLICENSED. This is a personal project for a single owner.

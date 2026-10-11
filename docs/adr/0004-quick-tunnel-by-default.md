# ADR 0004: Cloudflare Quick Tunnel by Default

- **Status:** Accepted
- **Date:** 2026-10-11
- **Qualifies:** ADR 0002 (Cloudflare ingress)
- **Related:** `PLAN.md`, `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` §4.1, §6.4–6.5,
  `server/src/tunnel/tunnelManager.js`, `server/src/tunnel/tunnelContext.js`

## Context

The Owner requirement is: run the project inside Ubuntu on WSL2, start it, and reach the terminal
from a phone **with no setup work**. ADR 0002 requires a Cloudflare named tunnel, DNS, an Access
application, a pinned email, and a validated `Cf-Access-Jwt-Assertion` on every remote request.
That path is correct for a stable deployment, but it cannot satisfy "no hassle": it needs a domain
on Cloudflare, dashboard work, and configuration before the first phone login.

TermPilot solves this with a Cloudflare **quick tunnel** — an anonymous, ephemeral
`*.trycloudflare.com` URL obtained by running `cloudflared tunnel --url http://127.0.0.1:<port>`.
It needs no account, login, DNS, or config file, and it dials outbound, so no port is opened.

## Decision

**`npm start` deploys a quick tunnel by default.** The server:

1. Spawns `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate` as an argument array
   (never through a shell) and scrapes stdout and stderr for the `*.trycloudflare.com` URL.
2. Prints the URL as `Phone URL: <url>` with a one-line security warning, and writes a
   `tunnel_ready` log event.
3. Accepts the tunnel origin for that process only, via `OriginPolicy.addRuntimeOrigin`. Nothing
   is written to disk and nothing survives a restart.
4. Skips the Cloudflare Access assertion requirement **only while a tunnel is running**, for
   requests that carry Cloudflare tunnel headers.
5. Keeps binding `127.0.0.1` only. Suppress the tunnel with `--no-tunnel` or `TUNNEL=0`; force it
   with `--tunnel` or `TUNNEL=1`.

Setup now asks one question first — *"Use a Cloudflare quick tunnel, with no Cloudflare account or
settings?"* — and on `yes` skips the four Cloudflare prompts entirely. `server.tunnelMode` records
`quick` (default) or `named`.

## Why skipping the assertion is sound

The server binds loopback, so the only process that can connect is `cloudflared`, and cloudflared
forwards nothing but our own tunnel. A request bearing Cloudflare tunnel headers therefore arrived
through that tunnel. Skipping the assertion is scoped to exactly those requests, and only while a
tunnel is running. With no tunnel, the original fail-closed behavior of ADR 0002 is unchanged, and
an integration test asserts it.

## Consequences

Positive:

- Zero-setup phone access: one command, one URL, one login.
- No inbound ports, no account, no dashboard, no DNS.
- tmux sessions survive the restart that inevitably changes the URL.

Negative and accepted:

- **No Cloudflare Access layer.** The public URL is protected by the Argon2id application login,
  CSRF, strict Origin, and cookies only. There is no edge identity check.
- **Ephemeral URL.** It changes on every start, so a phone bookmark may go stale.
- **Best-effort service.** Quick tunnels have no uptime guarantee, can take several seconds to
  become reachable, and Cloudflare may rate-limit them.
- A domain-less URL is weaker than a stable hostname plus Access for anyone who obtains the URL.

## Safeguards retained in tunnel mode

- Login required on every request (401 without a valid Login Session).
- CSRF double-submit enforced on every mutation (403 on mismatch).
- Origin policy enforced whenever an `Origin` header is present (403 for anything not allowed).
- Rate limiting on login and WebSocket authentication.
- Argon2id password hashing with random salt and constant-time comparison.
- Structured logs never contain passwords, keystrokes, terminal output, cookies, or tokens.
- `cloudflared` missing, or the tunnel failing to start, leaves the server on loopback only. The
  failure never blocks startup.

## Alternatives considered

- **Require ADR 0002 always.** Rejected: contradicts the explicit no-setup requirement.
- **Quick tunnel as an opt-in flag.** Rejected: the Owner asked for the default to just work.
- **Token in the tunnel URL.** Rejected: credentials in URLs leak into logs and history.
- **Automate named-tunnel provisioning.** Rejected: mutating the Owner's Cloudflare account is an
  irreversible operational action outside the agent's remit, and it still needs a domain.

## Operational note

Anyone who obtains the tunnel URL can reach the login screen, so the Owner password must be strong
(the setup policy already requires 15+ Unicode code points). For a permanent deployment with a
stable hostname and full Access validation, use the manual path in `docs/setup.md` and set
`server.tunnelMode` to `named`.

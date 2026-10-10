# ADR 0002: Cloudflare Tunnel + Access + Application Login

- **Status:** Accepted
- **Date:** 2026-10-10
- **Supersedes:** PRD v1.1 private-network remote access model
- **Related:** `PLAN.md`, `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` §6.4–6.5

## Context

The product exposes an unrestricted shell. A public URL alone is not an access-control mechanism,
so remote ingress needs transport encryption and an identity layer in front of the application.

PRD v1.1 proposed a private-network model (Tailscale Serve style). That requires the Owner to
install and maintain a mesh client on every device. PRD v1.2 instead assumes the Owner already
runs Cloudflare for their domains, and needs reachability from phones that will never join a mesh.

## Decision

Remote ingress uses three stacked layers:

1. **Cloudflare Tunnel** (`cloudflared`) terminates a public HTTPS/WSS hostname onto the
   loopback-only server. No port is opened on the Host Environment.
2. **Cloudflare Access** authenticates the Owner at the edge and injects
   `Cf-Access-Jwt-Assertion`. The application validates that assertion cryptographically:
   issuer, audience, expiry, token type, and the pinned owner email, with a cached JWKS and
   fail-closed behavior.
3. **Application login** is still required. Access proves identity at the edge; the Login Session
   governs the application itself, its cookies, and its CSRF rules.

Cloudflare provisioning (tunnel, DNS, Access application, policy) is a **manual prerequisite**
documented in `docs/setup.md`. The agent never performs or automates Cloudflare account changes.

Origins are restricted to localhost and the one configured Cloudflare origin. Everything else is
rejected for HTTP mutations and WebSocket upgrades.

## Consequences

Positive:

- No inbound ports, no mesh client, works from any phone browser.
- The Owner's existing Cloudflare setup is reused rather than extended with new infrastructure.
- Edge identity is verified, not assumed: the assertion header is validated, never trusted.

Negative:

- Remote WebSockets close at Access JWT expiry and Cloudflare may terminate sockets during edge
  updates, making jittered-backoff reconnection mandatory rather than optional.
- One pinned owner email; adding a device identity means an Access policy change, not an app
  change.
- A staging Cloudflare environment is required to actually verify remote behavior.

## Alternatives considered

- **Browser-based remote access via a private mesh network.** Rejected: requires client software
  on every device, which conflicts with the goal of any-browser access from a phone.
- **Expose the server publicly with only application login.** Rejected: puts an unauthenticated
  attack surface on the internet in front of a shell.
- **Rely on the Cloudflare Access cookie without validating the JWT.** Rejected: a missing or
  forged assertion would be indistinguishable from a valid one at the application boundary.
- **Let the automated agent create the tunnel and Access application.** Rejected: mutating the
  Owner's Cloudflare account is an irreversible operational action outside the agent's remit.

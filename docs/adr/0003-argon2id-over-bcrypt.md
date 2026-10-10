# ADR 0003: Node-Native Argon2id Over bcrypt

- **Status:** Accepted
- **Date:** 2026-10-10
- **Supersedes:** PRD v1.1 bcrypt, cost factor 12
- **Related:** `PLAN.md`, `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` §6.2

## Context

PRD v1.1 hashed the Owner's password with bcrypt at cost 12 through a native npm binding.
That adds a compiled dependency to a project that otherwise depends on native modules only where
the operating system demands it (`node-pty`), and it caps the password at 72 UTF-8 bytes with
silent truncation beyond that.

Node.js 24.7+ exposes asynchronous native Argon2id through `crypto.argon2`, which removes the
dependency entirely.

## Decision

Use Node's asynchronous native Argon2id implementation:

- Random 16-byte salt per password.
- Algorithm parameters stored alongside the hash.
- Constant-time comparison of derived keys.
- Node.js 24.7.0 LTS becomes a hard runtime prerequisite, asserted by the setup CLI.

There is no migration path to build: no implementation or stored credentials exist yet, so no
bcrypt hashes need conversion.

Passwords are 15–128 Unicode code points; bcrypt's 72-byte truncation concern disappears with it.

## Consequences

Positive:

- One fewer native dependency and one fewer compiled-on-install failure mode.
- Memory-hard hashing with a modern algorithm and parameters under our control.
- Unicode code-point length rules apply without a byte-length edge case.

Negative:

- Node 24.7.0 becomes mandatory; older LTS lines, including 22.x, are not sufficient.
- Argon2id parameters must be chosen deliberately and stored with the hash so verification can
  reconstruct them.

## Alternatives considered

- **Keep bcrypt 12.** Rejected: still a native dependency, still byte-truncating, and offers no
  advantage once Node provides Argon2id natively.
- **Use an Argon2id npm package.** Rejected: it would reintroduce the compiled dependency this
  decision removes.
- **Use scrypt via `crypto.scrypt`.** Rejected: Argon2id's memory-hardness parameters are more
  straightforward to document and store, and it is the algorithm already specified in `PLAN.md`.

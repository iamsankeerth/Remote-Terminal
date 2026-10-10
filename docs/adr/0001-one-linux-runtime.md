# ADR 0001: One Linux Runtime for Native Linux and WSL2

- **Status:** Accepted
- **Date:** 2026-10-10
- **Supersedes:** PRD v1.1 mixed-platform support
- **Related:** `PLAN.md`, `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` §2.2

## Context

PRD v1.1 allowed Linux, macOS, Windows with WSL, and Windows without WSL. That range forced
platform-specific behavior in exactly the places that are hardest to test: tmux availability,
`node-pty` builds, credential file permissions, and shell semantics. Windows without WSL cannot
guarantee persistent sessions at all.

## Decision

The application supports exactly two host configurations: native Linux, and Ubuntu inside WSL2 on
a Windows 11 host. Node.js, tmux, `node-pty`, and `cloudflared` all run inside the same distro.

Native Windows Node, PowerShell, and CMD terminals are out of scope.

## Consequences

Positive:

- One shell model, one set of permission semantics (0700/0600 on XDG paths), one build toolchain
  for `node-pty`.
- On Windows, the Owner launches one WSL2 distro and everything lives inside it.

Negative:

- A Windows Owner must maintain an Ubuntu install and cannot run the app from PowerShell directly.
- Release verification is limited to two platforms, with other distributions explicitly
  unverified.

## Alternatives considered

- **Keep Windows-without-WSL support.** Rejected: PRD v1.1 already conceded persistence was not
  guaranteed there, and supporting it doubles the platform matrix for a deploy built for one owner.
- **Support macOS natively.** Rejected for this MVP: it would require a third permission model
  (Keychain-style storage, `brew` tmux) for no product gain.
- **Docker container as the only runtime.** Rejected: the product's purpose is control over the
  Owner's own shell and files; containerizing it would hide the very processes the Owner wants.

## Verification

Setup validation asserts the runtime is Linux and that, when invoked on Windows, the process is
running inside WSL2. Node 24.7+, tmux, and non-root execution are asserted at setup time. Release
gates run on Windows 11 + Ubuntu WSL2 and native Ubuntu 24.04 LTS.

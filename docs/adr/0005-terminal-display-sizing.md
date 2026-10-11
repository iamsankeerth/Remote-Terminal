# ADR 0005: Terminal Display Follows the Largest Attached Client

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` §4.4–4.5,
  `server/src/websocket/gateway.js`, `server/src/terminal/tmuxManager.js`,
  `client/src/components/TerminalWorkspace.jsx`

## Context

The browser attached at a hardcoded 80x24 while xterm.js rendered a fitted, much wider viewport,
so full-screen TUIs drew layouts that did not match the display. Separately, tmux sizes a shared
window to the smallest attached client, so a narrow local terminal clamped a wide browser tab with
no visible explanation. Both produced the same symptom: garbled, overlapping output.

## Decision

1. The client fits first and sends its real `cols`/`rows` in the `attach` payload (validated like
   `resize`; bare attaches keep the 80x24 fallback). Session creation uses the current tab size.
2. The attach pty is spawned at those dimensions and tmux follows a newly attached client
   automatically, so a stale size left by a previous client self-corrects. Deliberately, no
   explicit `resize-window` runs on attach: it would freeze the window size and ignore all later
   client resizes.
3. App-owned sessions set `status off` (reclaims the row the status bar stole and hides the
   internal session name) and `aggressive-resize on` (the window follows the largest client, not
   the smallest).
4. The `attached` frame reports `foreignClients`, and the UI shows a notice naming the remedy
   (detach the other client) instead of failing silently. Foreign clients are never detached
   automatically.

## Consequences

Positive:

- Correct rendering at any size, one reclaimed row, no silent clamping.

Negative and accepted:

- With `aggressive-resize`, the tradeoff moves to the smaller client: when the browser is bigger,
  a narrow local terminal wraps. The notice makes this visible instead of mysterious.
- Sessions created before this change keep the status bar until recreated.

## Alternatives considered

- **Detach foreign clients on browser attach.** Rejected as destructive to an active local workflow.
- **Rely on resize-after-fit.** Rejected: the race between attach and the first resize is the bug.

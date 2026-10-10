# CONTEXT

Remote Terminal — domain glossary. This file defines the vocabulary of the product. Code, tests,
and the PRD use these terms with these meanings. When another document and this file disagree,
this file wins on vocabulary.

## Terms

### Owner

The single person this deployment is built for. One owner per installation. The Owner is
identified by a username, a password, and one pinned Cloudflare Access email. There is no
multi-user concept: everyone who reaches a terminal is the Owner on a different device.

### Host Environment

The one Linux machine the application runs on: either native Linux or Ubuntu inside WSL2 on a
Windows host. The Host Environment owns tmux, `node-pty`, and every real process behind a
Terminal Session. Node, tmux, `node-pty`, and `cloudflared` all run inside the same distro.

### Terminal Session

A shell the application started for the Owner, backed by a tmux session the application created.
It has an internal identifier (an instance namespace plus an opaque random ID), a display label
(unique, case-insensitive, 1–64 Unicode code points), a creation time, and a lifecycle the
application tracks in JSON metadata. A Terminal Session outlives any browser connection. The
application never creates, mirrors, or manages tmux sessions it did not create.

### Login Session

The Owner's authenticated relationship with the server. It is created at login, held in memory
only, and referenced by a host-only, HTTP-only, `SameSite=Strict` cookie with a 30-day sliding
lifetime. A server restart revokes all Login Sessions. Logout revokes one device; a password
change or global revocation revokes all of them.

### Browser Connection

One browser client connected to the server through Cloudflare or localhost. Capped at 1–10 active
connections. A Browser Connection holds at most one attached Terminal Session at a time and is
identified to the server so control can be reserved for it after an unexpected disconnect.

### Controller

The one Browser Connection currently allowed to send input to a given Terminal Session. Exactly
one Controller exists per Terminal Session. Another device must Takeover to become the
Controller.

### Attachment

The relationship between a Browser Connection and a Terminal Session in which the Connection is
the Controller and is receiving output. There is exactly one attached Terminal Session per
Browser Connection, and switching tabs Detaches the previous one.

### Detach

The act of ending an Attachment without ending the Terminal Session. Detach keeps the tmux
session and its processes running. Detach is a WebSocket-lifecycle event; it is never an HTTP
request. An unexpected disconnect behaves like a Detach but reserves control for the same
browser client for 30 seconds.

### Takeover

The explicit confirmation a second device must give to become the Controller of a Terminal Session
that already has a Controller. Until confirmed, the existing Controller keeps control.

### Terminate

The deliberate ending of a Terminal Session and its tmux session. It requires a named
confirmation and is broadcast to every Browser Connection. Terminate is distinct from Detach:
closing a tab never terminates a session.

## Example dialogue

> Owner on laptop: "Terminal 1 is running the build. I need to check it from my phone."

The Browser Connection on the laptop Detaches. The Terminal Session keeps running under tmux.

> Owner on phone: opens the app, enters the password, creating a new Login Session and Browser
> Connection. The session list shows Terminal 1. The Owner taps Terminal 1 and sends Attach.

Because the laptop disconnected cleanly, no reservation remains, and the phone Attaches and becomes
the Controller.

> Owner on laptop: comes back and taps Terminal 1. The server replies that another Browser
> Connection is the Controller.

The laptop must confirm Takeover. On confirmation the phone Detaches, the laptop Attaches, and the
build output continues uninterrupted in both views.

> Owner on laptop: decides the build is stuck. The Owner chooses Terminate and confirms the named
> warning.

The server kills the tmux session, removes the Terminal Session, and broadcasts the change to
every Browser Connection. No detached browser ever needs to know this in advance, and no tmux
session outside the application's own namespace was ever touched.

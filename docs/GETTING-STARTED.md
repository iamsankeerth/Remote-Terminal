# Getting Started

The shortest path from a fresh WSL2 terminal to your terminal on your phone. Everything here is
one-time setup except the last two commands, which you run every time.

## Before you start

You need Ubuntu on WSL2 with **Node.js 24.7 or newer** and `tmux`. If you have never installed
them, see [Host prerequisites](#host-prerequisites) below.

Open a terminal in WSL:

```powershell
wsl -d Ubuntu
```

## Step 1 — Go to the project

```bash
cd "/mnt/c/Users/lenovo/Desktop/San/Fun_Projects/Remote Terminal"
```

## Step 2 — Confirm the runtime

```bash
node -v    # must print v24.7.0 or newer
tmux -V    # must print tmux 3.x
```

If `node -v` prints something older, such as `v18.19.1`, your shell is using the system Node
instead of the one nvm installed. Fix it once:

```bash
nvm install 24
nvm use 24
nvm alias default 24
```

Then run `node -v` again. (The server also refuses to start with a clear message if the Node
version is too old, so you cannot get a confusing failure further down.)

## Step 3 — Install dependencies

```bash
npm install
```

## Step 4 — Build the web client

```bash
npm run build
```

This compiles the React interface into `client/dist`, which the server serves. You only need to
repeat it when you change the client.

## Step 5 — Create your account

```bash
npm run setup
```

Answer the prompts. No implicit defaults: every question needs a value, and pressing Enter on an
empty answer simply re-asks.

| Prompt | What to enter |
| --- | --- |
| `Replace it? (yes/no)` | `yes` if a configuration already exists |
| `Owner username` | the username you will sign in with, for example `Sankeerth` |
| `Owner password` | any passphrase of **15 characters or more**; input is hidden, so type it carefully |
| `Owner password` (repeat) | the same passphrase again |
| `Server port (loopback only)` | `8080` |
| `Use a Cloudflare quick tunnel…? (yes/no)` | `yes` |
| `Terminal Session limit (1-20)` | `5` |
| `Active Browser Connection limit (1-10)` | `5` |

Write the password down. It is hashed with Argon2id and stored in `~/.config/remote-terminal/`, and
there is no recovery path: forgetting it means running setup again.

Choosing `yes` for the quick tunnel is what makes the phone work with no Cloudflare account, no DNS,
and no dashboard. Your password is the only gate, which is why it must be strong.

## Step 6 — Start the server

```bash
npm start
```

Within about ten seconds you will see:

```text
Remote Terminal listening on http://127.0.0.1:8080
Sessions: 5
  Tunnel:    starting Cloudflare quick tunnel...

  Phone URL: https://calm-words-1234.trycloudflare.com
  Open it on any device and sign in with your owner username and password.
  This URL is temporary and changes every time the server restarts.
  Anyone with this URL can reach the login screen: use a strong password.
```

Leave this terminal open. It is the server; closing it stops the server and the tunnel. To run
without remote access, use `npm start -- --no-tunnel` instead.

## Step 7 — Open it on this laptop

In any browser on the laptop, open:

```text
http://127.0.0.1:8080
```

(`localhost:8080` is the same thing.) Sign in, click **New session**, and you have a shell. This
address works offline and never touches the tunnel.

The tunnel URL also opens in the laptop's own browser — same server, reached via Cloudflare.

## Step 8 — Open it on your phone

1. On your phone, open Chrome (Android) or Safari (iOS).
2. Type the **`Phone URL`** exactly as printed, including `https://`.
3. Sign in with the username and password from Step 5.
4. Tap **New session**. You now have a real shell on your machine.

The first request can take a few seconds while Cloudflare warms up the tunnel. If you see a
Cloudflare error page, wait a moment and reload.

### What works on the phone

- Full interactive terminal: run commands, use `vim`, `htop`, and anything that needs a prompt.
- The special-key row above the keyboard gives you **Esc, Tab, Ctrl, Alt, Enter, Backspace, arrow
  keys**, and `|`, `/`, `~`, `-`, `.` — the keys a phone keyboard hides. Tap **Ctrl** and then a
  letter for `Ctrl+C`; the same works with **Alt**.
- Tap the caret on the left of that row to collapse it out of the way.
- Font size and scrollback are in the header; your choices are remembered on that device only.
- Add to home screen for a full-screen icon: Chrome's menu → *Add to Home screen*, or Safari's
  share sheet → *Add to Home Screen*.

### Takeover from a second device

Open the same URL on another device and attach to the same session. The first device keeps control
until the second device **confirms takeover**. If a device loses its connection unexpectedly, its
control is reserved for 30 seconds so nobody else can grab the session mid-outage.

## Step 9 — Stop it

Press `Ctrl+C` in the server terminal. The tunnel and the server both stop, and tmux sessions stay
alive on disk for the next start.

## Every time after this

```bash
cd "/mnt/c/Users/lenovo/Desktop/San/Fun_Projects/Remote Terminal"
npm start
```

Then read the new `Phone URL` — it changes on every start, because it is an ephemeral tunnel.

## Attach to a session locally with tmux

The terminal sessions the app creates are ordinary tmux sessions in the same WSL distro, named with
the prefix `rt1`. From any WSL terminal (not PowerShell — the tmux server lives inside Ubuntu):

```bash
# List the app's sessions (Terminal 1, Terminal 2, … are the rt1* entries)
tmux ls | grep '^rt1'

# See which display label maps to which internal name
cat ~/.local/share/remote-terminal/terminal-sessions.json

# Attach to one, e.g. Terminal 1 whose id is abc123
tmux attach-session -t rt1abc123
```

Inside the attached session, **Ctrl+b then d** detaches and leaves everything running — exactly
like the app's own Detach. Both the browser tab and your local terminal then show the same shell,
and keystrokes from either go to the same place.

Rules:

- Attach and detach freely, from as many windows as you like.
- When two different-sized terminals share one session, the window follows the **largest** one, so
  a narrow local window does not shrink a wide browser tab (and the reverse: a bigger browser tab
  makes a narrow local window wrap). The browser shows a notice while another client is attached;
  detach the one you are not using (`Ctrl+b`, `d`) for a clean view on both.
- Do **not** rename the session from inside tmux: the app addresses its sessions by their internal
  `rt1…` name, and renaming breaks that link.
- If you kill a session outright (`tmux kill-session -t rt1…`), the app notices on its next
  reconciliation and drops it from the list — safe, but use the app's Terminate button when you
  want the confirmation dialog instead.

## Host prerequisites

Only needed on a brand-new Ubuntu on WSL2:

```bash
# Node 24.7+ through nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
exec bash -l
nvm install 24
nvm alias default 24

# tmux, the compiler toolchain for node-pty, and cloudflared
sudo apt-get update
sudo apt-get install -y tmux build-essential python3

# cloudflared without root
mkdir -p ~/.local/bin
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/.local/bin/cloudflared
chmod +x ~/.local/bin/cloudflared
cloudflared --version
```

## When something goes wrong

| Symptom | Cause and fix |
| --- | --- |
| `node -v` prints v18 | Your shell did not load nvm. Run `nvm use 24`, then `node -v` again. |
| `npm start` says no owner password | You have not run setup, or the configuration was reset. Run `npm run setup`. |
| `npm start` says Node is too old | Same fix as the first row: switch to Node 24 before starting. |
| No `Phone URL` appears | `cloudflared` is missing; the server log prints the install command and stays on loopback. |
| The URL shows a Cloudflare error | The tunnel is still warming up. Wait a few seconds and reload. |
| Login always says invalid credentials | Password is shorter than 15 characters or the username differs from setup. |
| The phone shows "Reconnecting" | Cloudflare closed the socket; the client reconnects with backoff automatically. |
| Terminal output stalls | A slow browser exceeded the 1 MiB buffer and was detached; tmux keeps running. |

## Own your own domain instead

If you want a permanent URL with Cloudflare Access in front of it, see `docs/setup.md` for the
named-tunnel path. Answer `no` to the quick-tunnel question in setup, then follow Path B. It needs a
domain on your Cloudflare account, and `docs/release-gates.md` records what that path still needs
verified.

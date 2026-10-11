# Host and Cloudflare Setup

Two paths exist. **Path A is the default and needs no Cloudflare account.** Path B is the
stable-hostname deployment with full Cloudflare Access validation (ADR 0002).

---

## Path A — Quick tunnel (default, zero setup)

### 1. Host environment

Inside native Linux, or inside **Ubuntu on WSL2** on a Windows 11 host:

```bash
# Node 24.7+ LTS (native asynchronous Argon2id)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
exec bash -l
nvm install 24
node -v   # must report v24.7.0 or newer

# tmux and node-pty build prerequisites
sudo apt-get update
sudo apt-get install -y tmux build-essential python3
whoami    # must not be root
```

### 2. Install cloudflared

A quick tunnel only needs the `cloudflared` binary. It works installed in your home directory, so
no `sudo` is required:

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/.local/bin/cloudflared
chmod +x ~/.local/bin/cloudflared
cloudflared --version
```

> **Why this matters:** `~/.local/bin` is only on `PATH` in login shells. A server started from an
> IDE terminal, a script, or a service may not see it. The application searches `PATH`,
> `~/.local/bin`, `~/bin`, and the usual system locations, so it finds the binary either way. Set
> `CLOUDFLARED_PATH` to override the lookup entirely.

### 3. Install the project

```bash
cd "/mnt/c/Users/lenovo/Desktop/San/Fun_Projects/Remote Terminal"
npm install
npm run build
```

### 4. Configure

```bash
npm run setup
```

Answer **yes** to *"Use a Cloudflare quick tunnel, with no Cloudflare account or settings?"* and
the four Cloudflare prompts are skipped. Setup still asks for your username, password, port, and
the session and connection limits.

### 5. Run

```bash
npm start
```

```text
Remote Terminal listening on http://127.0.0.1:8080
Sessions: 5
  Tunnel:    starting Cloudflare quick tunnel...
  Phone URL: https://calm-words-1234.trycloudflare.com
  Open it on any device and sign in with your owner username and password.
  This URL is temporary and changes every time the server restarts.
  Anyone with this URL can reach the login screen: use a strong password.
```

Give the URL a few seconds to become reachable, then open it on your phone and sign in.

### What is protected, and how

| Layer | Quick tunnel |
| --- | --- |
| Network exposure | Loopback bind only; `cloudflared` dials outbound |
| Identity | Argon2id application login, no Cloudflare Access |
| Requests | Login required, CSRF double-submit, strict Origin, rate limiting, cookies host-only/HTTP-only/SameSite=Strict |
| Logs | Operational metadata only, never secrets or terminal content |

Anyone with the URL can reach the login screen, so the Owner password must be strong. For a
permanent deployment, use Path B.

### Controls

| Command | Effect |
| --- | --- |
| `npm start` | Quick tunnel deployed (default) |
| `npm start -- --no-tunnel` | Loopback only, no tunnel |
| `TUNNEL=0 npm start` | Same as `--no-tunnel` |
| `TUNNEL=1 npm start` | Force the tunnel even in named-tunnel mode |

---

## Path B — Named tunnel + Cloudflare Access (stable hostname)

Use this when you want a permanent URL and edge identity validation.

### 1. Host environment

Same as Path A step 1. `cloudflared` is also required:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

### 2. Cloudflare Tunnel (manual)

1. In the Cloudflare dashboard, create a **Cloudflare Tunnel** for the hostname you will use, for
   example `terminal.example.com`.
2. Install and configure `cloudflared` inside the same Linux distribution with the token it gives
   you, routing it to the application's loopback address:

```yaml
# /etc/cloudflared/config.yml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: terminal.example.com
    service: http://127.0.0.1:<PORT>
  - service: http_status:404
```

3. Ensure the tunnel forwards WebSocket upgrades. `cloudflared` does this by default; do not
   disable WebSocket support in the dashboard.

### 3. Cloudflare Access (manual)

1. Create an **Access application** protecting `terminal.example.com`.
2. Add a policy allowing exactly one pinned email address.
3. Note the **Application Audience (AUD)** from the application page.
4. Note your **team domain**, for example `myteam.cloudflareaccess.com`.
5. Set the Access application session duration as you prefer. The application has its own
   independent 30-day sliding Login Session.

### 4. Run setup and start

```bash
npm install
npm run setup      # answer "no" to the quick tunnel question
npm run build
npm start
```

Locally: `http://127.0.0.1:<PORT>`. Remotely: `https://terminal.example.com` through Cloudflare
Access.

---

## 6. Verification checklist

- [ ] `tmux -V` works inside the Linux distribution.
- [ ] `node -v` reports 24.7.0 or newer.
- [ ] `cloudflared --version` works.
- [ ] A `Phone URL` is printed within about ten seconds of `npm start`.
- [ ] The URL opens in a browser and shows the login screen.
- [ ] A wrong password is rejected with a clear error.
- [ ] Path B only: a wrong or missing `Cf-Access-Jwt-Assertion` is rejected (fail-closed).
- [ ] Path B only: local origin requests work without Cloudflare.

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| No `Phone URL` printed | `cloudflared` is not installed or not executable; the server log records `tunnel_binary_missing` with the install command, and the server stays on loopback |
| URL returns 530 for a while | Cloudflare is warming the tunnel; wait a few seconds and reload |
| URL returns 502 | The origin is unreachable: the server is not running, or it is bound to a different port than the one in `--url` |
| Login always fails | Password shorter than 15 code points, or the username differs from setup |
| Remote requests get 403 (Path B) | Access assertion failed: wrong AUD, wrong pinned email, or clock skew |
| WebSocket closes immediately | The Access JWT expired; the client reconnects automatically |
| Phone shows "Reconnecting" | Cloudflare closed the socket; reconnection with backoff is expected |
| Terminal output stalls | A slow browser exceeded the 1 MiB buffer and was detached; tmux keeps running |
| Port already in use | Re-run `npm run setup` with a different port, or free the port |

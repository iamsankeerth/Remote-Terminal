# Host and Cloudflare Setup

This document covers the manual prerequisites. The application itself never performs these steps.

## 1. Host environment

Inside native Linux, or inside **Ubuntu on WSL2** on a Windows 11 host:

```bash
# Node 24.7+ LTS (native asynchronous Argon2id)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 24
node -v   # must report v24.7.0 or newer

# tmux and node-pty build prerequisites
sudo apt-get update
sudo apt-get install -y tmux build-essential python3

# Non-root execution is required
whoami    # must not be root
```

On Windows, start the distro with `wsl -d Ubuntu` and run everything from inside it.

## 2. Cloudflare Tunnel (manual)

1. In the Cloudflare dashboard, create a **Cloudflare Tunnel** for the hostname you will use, for
   example `terminal.example.com`.
2. Install and configure `cloudflared` inside the same Linux distribution:

```bash
# Example service install against an existing tunnel token
sudo cloudflared --no-autoupdate service install <TUNNEL_TOKEN>
```

3. Route the tunnel to the application's loopback address:

```yaml
# /etc/cloudflared/config.yml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: terminal.example.com
    service: http://127.0.0.1:<PORT>
  - service: http_status:404
```

4. Ensure the tunnel forwards WebSocket upgrades. `cloudflared` does this by default; do not
   disable WebSocket support in the dashboard.

## 3. Cloudflare Access (manual)

1. Create an **Access application** protecting `terminal.example.com`.
2. Add a policy allowing exactly one pinned email address.
3. Note the **Application Audience (AUD)** from the application page.
4. Note your **team domain**, for example `myteam.cloudflareaccess.com`.
5. Set the Access application session duration as you prefer. The application has its own
   independent 30-day sliding Login Session, so a longer Access session simply reduces the number
   of Access re-authentications.

## 4. Run setup

```bash
npm install
npm run setup
```

The setup CLI asks for, with no implicit defaults:

| Prompt | Example |
| --- | --- |
| Owner username | `sank` |
| Owner password | 15–128 Unicode code points, input hidden |
| Server port (loopback) | `8080` |
| Cloudflare hostname | `terminal.example.com` |
| Cloudflare team domain | `myteam` |
| Access Application Audience (AUD) | `abc123...` |
| Pinned owner email | `you@example.com` |
| Terminal Session limit (1–20) | `5` |
| Browser Connection limit (1–10) | `5` |

## 5. Build and start

```bash
npm run build
npm start
```

Locally: `http://127.0.0.1:<PORT>`.
Remotely: `https://terminal.example.com` through Cloudflare Access.

## 6. Verification checklist

- [ ] `tmux -V` works inside the Linux distribution.
- [ ] `node -v` reports 24.7.0 or newer.
- [ ] `cloudflared` runs as a service and the public hostname resolves.
- [ ] Access login prompts for the pinned email.
- [ ] A wrong or missing `Cf-Access-Jwt-Assertion` is rejected by the server (fail-closed).
- [ ] Local origin requests work without Cloudflare.
- [ ] WebSocket connects over `wss://` and survives a forced socket close.

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Setup refuses to run | Node older than 24.7.0, tmux missing, or running as root |
| Login always fails | Password shorter than 15 code points, or the username differs from setup |
| Remote requests get 403 | Access assertion failed: wrong AUD, wrong pinned email, or clock skew |
| WebSocket closes immediately | Access JWT expired; the client reconnects automatically |
| Terminal output stalls | A slow browser exceeded the 1 MiB buffer and was detached; tmux keeps running |

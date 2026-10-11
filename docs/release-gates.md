# Release Gates

The gates that PRD v1.2 section 10.5 requires before the MVP may be called verified. Each entry
states what is automated, what is measured, and what still needs a human or real hardware.

## 1. Automated gates (run in CI or locally)

| Gate | Command | Status |
| --- | --- | --- |
| Unit tests | `npm test` (node --test, unit + integration, serialized) | Passing |
| Client build | `npm run build` | Passing |
| Source syntax | `node --check` over `server/src` and `shared/src` | Passing |
| Browser workflows | `npm run test:e2e` (Playwright, desktop + Android viewport) | Passing |
| Local echo latency | `npm run benchmark --workspace @remote-terminal/server` | P95 ~11 ms, gate 150 ms |

Notes:

- Integration tests share one tmux server, so they run with `--test-concurrency=1`. Running the
  files in parallel makes one file's cleanup destroy another's session.
- The Playwright suite boots its own isolated server via `tests/e2e/boot-test-server.js`, with its
  own XDG directories and its own owner account, so it never touches the real configuration.
- `npx playwright install chromium` is required once. The base WSL Ubuntu image is also missing
  `libnspr4`, `libnss3`, and `libasound2`, without which Chromium fails with "error while loading
  shared libraries". Either run `npx playwright install-deps chromium` (needs root), or install
  them into the home directory without root:

  ```bash
  bash scripts/install-chromium-deps.sh
  export LD_LIBRARY_PATH="$HOME/.local/lib/playwright-libs/lib"
  ```

  The script downloads the three `.deb` packages, extracts them under `~/.local/lib`, and creates
  the `libasound.so.2` soname link that the runtime package omits.
- If a test run is interrupted, tmux can leave `tmux-client-<pid>.log` and `tmux-server-<pid>.log`
  files in the working directory. They are diagnostic output from an abnormally terminated tmux
  server, not product behaviour: a normal create, attach, detach, kill cycle produces none. They
  are matched by the `*.log` gitignore rule and are safe to delete.

## 2. Platform gates

| Platform | Status |
| --- | --- |
| Windows 11 + Ubuntu on WSL2 | Exercised for every automated gate in this repository |
| Native Ubuntu 24.04 LTS | Not yet exercised on bare metal. The runtime, toolchain, and Node version are identical to the WSL2 distro used here, so the risk is low, but the gate is not claimed |
| Other distributions | Explicitly unverified |

## 3. Remote access gates

| Gate | Status |
| --- | --- |
| Quick tunnel end to end (phone URL, login, terminal round trip) | Passing. A smoke run created a tunnel, then verified 401 unauthenticated, 200 login, 401 bad password, 403 foreign origin, 201 create, WebSocket ready/attached, terminal input and output, detached, 200 terminate, 200 logout |
| Quick tunnel reachability | The URL takes a few seconds to become reachable after startup, and may answer 530 while Cloudflare warms it |
| Named tunnel + Cloudflare Access | Validator behaviour is covered by unit and integration tests, including a locally signed RS256 assertion against a local JWKS. A real Cloudflare staging smoke test has not been run, because it needs a domain on the owner's Cloudflare account |

## 4. Manual gates that still need a human

1. **Real Android Chrome smoke test.** The Playwright `android-viewport` project emulates a phone
   viewport with touch events. A physical device must still verify: the software keyboard with the
   special-key toolbar open, screen rotation, reconnection after losing and regaining network, and
   takeover from a second device.
2. **Native Ubuntu 24.04 bare-metal run.** Install prerequisites, run setup, and repeat the
   automated gates on real hardware.
3. **Named tunnel staging test.** With a real hostname: HTTPS/WSS reachability, Access enforcement,
   JWT renewal after expiry, email pinning, rejection of a foreign origin, and reconnect after a
   forced socket close.
4. **Long-running session survival.** Start a build, then let it run across a browser refresh, a
   Node restart, and a Cloudflare socket close, and confirm the process is still alive afterwards.

## 5. Latency measurement

```
npm run benchmark --workspace @remote-terminal/server
```

Measures the time from sending a command to receiving its output over the loopback WebSocket, over
100 samples by default, and reports min, p50, p95, max against the 150 ms gate. Remote latency
through Cloudflare is reported separately and has no universal SLA.

## 6. Definition of Done checklist

- [x] PRD v1.2 behaviour implemented, including HTTP API, WebSocket envelopes, terminal lifecycle,
      takeover, and the control lease
- [x] Security controls in place: Argon2id, strict Origin, CSRF, cookie attributes, fail-closed
      Cloudflare validation, 0600/0700 configuration
- [x] Unit, integration, security, and browser tests passing
- [x] Local echo latency under the P95 gate
- [ ] Mobile verified on a real device
- [ ] Native Ubuntu 24.04 verified on bare metal
- [ ] Named tunnel verified against real Cloudflare

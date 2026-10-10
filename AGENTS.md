# AGENTS.md

Remote Terminal
This file is the single source of truth for any coding agent working in this repo: Claude Code, OpenAI Codex CLI / Codex Cloud, Google Gemini CLI, Google Antigravity, Cursor, Windsurf, opencode, Aider, goose, Factory, RooCode, JetBrains Junie, GitHub Copilot, Devin, or any other AGENTS.md-aware tool.

Read this file in full before taking any action. Obey it exactly.

---

## 0. TLDR FOR THE AGENT

On every session start, do this in order:

1. Read this file completely.
2. Initialize the codebase-audit log described in §2 (create its directory and file if absent).
3. Append a `SESSION START` entry to that log (§4.1).
4. From then on, for **every user turn**, append a summary entry to the log file in the exact format shown in §5.
5. For **every material implementation decision, file change, mutating command, and test**, write the additional audit entries required by §9, at the time the action happens. A per-turn summary alone is not sufficient.
6. Follow the project conventions in §6 when building, changing, or testing this codebase.

You are **not** allowed to skip logging or rewrite old log entries. If you are a sub-agent or
running inside a git worktree, the same rules apply and you share the audit log in §2. Pass its
exact path to every sub-agent and worktree.

---

## 1. WHAT THIS REPO IS

**Remote Terminal** — a personal, self-hosted, browser-based remote terminal for one owner. The
product lets the owner attach to, control, detach from, take over, and terminate terminal sessions
running on their own host machine from any of their devices.

Authoritative product and architecture sources (read these before implementing anything):

- `PLAN.md` — PRD v1.2 plan and MVP implementation scope (the current direction)
- `Remote_Terminal_PRD_v1.2_argon2id_cloudflare.md` — PRD v1.2 (authoritative behavior spec)
- `Remote_Terminal_PRD_v1.1_bcrypt.md` — PRD v1.1 (superseded on security and hosting decisions)
- `CONTEXT.md` — glossary of domain terms (authoritative vocabulary)
- `docs/adr/` — architecture decision records
  (`0001` one Linux runtime, `0002` Cloudflare ingress, `0003` Argon2id over bcrypt)

MVP scope summary (from `PLAN.md`): runs entirely inside native Linux or Ubuntu on WSL2; Cloudflare
Tunnel + Access + application login for ingress; Node-native Argon2id password hashing; npm
workspaces with JavaScript ESM packages for `client`, `server`, and `shared`; tmux sessions managed
by the app; xterm.js frontend.

Explicitly out of MVP scope: native Windows Node, PowerShell/CMD terminals, external tmux session
management, multi-user access, databases, PWA, voice input, auto-start services, and full
output-history persistence.

---

## 2. CODEBASE AUDIT LOG — LOCATION AND LIFECYCLE

All audit entries go to a single log that lives **outside** the repository under the user's home
directory so that it survives branch switches, worktree creation, and `git clean`.

| Platform | Canonical log path | Evidence directory |
| --- | --- | --- |
| macOS / Linux | `$HOME/agent_code_audit/audit.log` | `$HOME/agent_code_audit/evidence/` |
| Windows | `%USERPROFILE%\agent_code_audit\audit.log` | `%USERPROFILE%\agent_code_audit\evidence\` |

**Mandatory initialization on every session start:**

1. Resolve the home directory with an OS-native method (for example `os.homedir()` in Node.js). Do not hardcode a username or a platform-specific home directory.
2. Create `agent_code_audit/` if it does not exist. Create `audit.log` if it does not exist. Use an append-only file opening mode and UTF-8 `\n` line endings. Never overwrite an existing log.
3. If the file is new or empty, append a single `AUDIT LOG CREATED` entry with actual timestamp, agent, and absolute repository path. Do not invent past activity.
4. Append a `SESSION START` entry (§4.1) and proceed.

Rules:

- **Create the log automatically if missing.** No manual initialization is normally necessary when the coding agent has filesystem permissions.
- **Never commit the log or evidence files to Git.** Keep them outside the repository.
- **Append-only.** Never rewrite, reorder, truncate, or delete past log entries. Corrections are new entries.
- **Shared** across all agents, sub-agents, and worktrees. All entries identify the repo root, worktree, and agent to distinguish concurrent projects.
- **Auditable.** Follow §9 for decisions, diffs, commands, tests, and evidence. Do not claim an action happened unless it did.
- **Protect permissions.** Give only the current user access where practicable; audit logs may contain project names and sanitized prompts.
- **Never log secrets.** Redact API keys, tokens, cookies, credentials, and sensitive PII in the log and all audit evidence. Replace pasted secrets with `[REDACTED]`. In particular, never log owner passwords, terminal keystrokes, terminal output, session cookies, Login Session tokens, or Cloudflare JWTs.

### 2.1 Permissions and external-directory access

Many coding agents run with their working directory restricted to the current repository. The audit directory is deliberately outside that repo, so filesystem reads/writes or shell operations targeting it may require **explicit external-directory permission**. Request that permission when prompted or use a narrowly scoped agent configuration. Never disable the audit trail to bypass a permission error. `AGENTS.md` gives instructions; it does not itself grant filesystem access.

---

## 3. SESSION START (EVERY SESSION)

There is no challenge onboarding gate in this repo. Every session simply:

1. Initializes/verifies the §2 log.
2. Appends a `SESSION START` entry (§4.1).
3. Greets the user briefly and proceeds with their request.

---

## 4. LOG FORMAT

### 4.1 Session start entry

```
## [ISO-8601 TIMESTAMP] SESSION START

Agent: <agent_name_or_unknown>
Repo Root: <absolute_path>
Branch: <git_branch_or_unknown>
Worktree: <worktree_path_or_main>
Parent Agent: <parent_agent_name_or_none>
Language: <js|ts|py|custom:name>
```

### 4.2 Per-turn entry (append after every user message you respond to)

```
## [ISO-8601 TIMESTAMP] <short title, max 80 chars>

User Prompt (verbatim, secrets redacted):
<exact user message, with secrets replaced by [REDACTED]>

Agent Response Summary:
<2-5 sentences: what was done, why, and any important decision>

Actions:
* <file edited / command run / tool invoked>

Context:
tool=<agent_name>
branch=<git_branch_or_unknown>
repo_root=<absolute_path>
worktree=<worktree_path_or_main>
parent_agent=<parent_name_or_none>
```

### 4.3 Sub-agent and worktree rules

- A sub-agent (Task tool, delegated worker, etc.) **must** log its own entries using the same file. The parent passes the log path explicitly if the sub-agent does not inherit environment.
- Set `parent_agent=` to the parent's name so entries are traceable.
- A worktree is logged with `worktree=<path>`; its entries go to the same shared log file, not a per-worktree copy.
- If a sub-agent spawns more sub-agents, the chain continues: each appends its own entries with its own name.

### 4.4 What not to log

- API keys, tokens, session cookies, OAuth codes, private keys, passwords.
- User PII beyond what they explicitly pasted into a prompt.
- Full contents of large files or binary blobs — reference by path instead.

---

## 5. PROJECT CONVENTIONS (REMOTE TERMINAL)

- **Runtime.** Node.js 24.7+ LTS (provides asynchronous native Argon2id). No TypeScript.
- **Layout.** npm workspaces with JavaScript ESM packages: `client`, `server`, `shared`.
- **Frameworks.** React + `@xterm/xterm` (with fit addon) on the client; Node.js with `ws`,
  `node-pty`, `tmux` on the server. No Express, Fastify, NestJS, or database.
- **Host.** Runs only inside native Linux or Ubuntu on WSL2. Binds to loopback only. Cloudflare
  Tunnel + Access provides remote ingress; Cloudflare provisioning is a documented manual
  prerequisite and must never be automated by the agent.
- **Security rules that always apply.** Argon2id password hashing with random salt and
  constant-time comparison; passwords 15–128 Unicode code points; strict Origin and CSRF
  validation on all HTTP mutations and WebSocket upgrades; host-only, HTTP-only,
  `SameSite=Strict` session cookies; config/metadata in XDG directories (0700 dirs, 0600 files,
  atomic replacement); structured logs must never contain secrets, keystrokes, or terminal output.
- **Determinism and testing.** Prefer fixed seeds and pinned behavior. Test setup validation,
  config permissions, password rules, hashing, session lifecycle, CSRF/origin, JWT claims,
  message schemas, tmux lifecycle, reconnection, and takeover semantics.
- **Secrets.** Read secrets from environment variables only. Never hardcode. Never commit `.env` or credentials.
- **Docs.** Product decisions belong in `PLAN.md`, `CONTEXT.md`, or `docs/adr/`; keep them in sync
  when behavior changes.

---

## 6. CROSS-PLATFORM AND AGENT-COMPATIBILITY NOTES

- **Path handling.** Always resolve the audit-log path using the platform's home dir (`os.homedir()` / `pathlib.Path.home()` / `$HOME` / `%USERPROFILE%`). Never hardcode `/Users/...` or `C:\Users\...`.
- **Permissions.** Because the log lives outside the repo, check that the coding agent can create and append to `$HOME/agent_code_audit/`. If external-directory access is denied, ask the user for narrowly scoped permission before mutating code.
- **Line endings.** Write the log in UTF-8 with `\n`. Don't emit `\r\n` even on Windows; most editors render `\n` fine.
- **Shell.** Don't assume bash. Prefer language-native APIs over shelling out. When you must shell out, provide both a Unix and a Windows form.
- **Tool-specific extras.** This file is the canonical source. If a tool (Claude Code, Cursor, etc.) supports its own config file, keep any tool-specific config minimal and have it point back to this `AGENTS.md` rather than duplicating rules.
- **Nested AGENTS.md.** If a sub-project adds its own `AGENTS.md`, the closest one wins for files inside that sub-project, but §2 (log file) and §4 (log format) are global and must not be overridden.

---

## 7. QUICK CHECKLIST FOR THE AGENT

Before you respond to any user message, confirm:

- [ ] I have read this file in this session.
- [ ] I initialized/verified the §2 audit log and wrote a `SESSION START` entry this session.
- [ ] I will append a §4.2 entry after this turn.
- [ ] I will not log secrets.
- [ ] I have recorded material decisions and changes with the evidence specified in §9.
- [ ] Every edited, added, deleted, or renamed file is accounted for (or explicitly marked as pre-existing/unknown).
- [ ] Commands, tests, failures, and unverified claims have accurate audit entries.
- [ ] I did not push anything to the remote unless the user explicitly permitted it.

If any box is unchecked, fix that first.

---

## 8. MANDATORY DECISION & CODE-CHANGE AUDIT TRAIL

**Purpose:** Make it possible to answer, after any coding session: **What did the agent decide? Why? Which files did it change? What exactly changed? Which commands and tests ran? Did they pass? How can the user review or undo the work?**

This section supplements §2 and §4. **Apply it to every agent, sub-agent, worktree, coding tool, and coding session.**

### 8.1 Scope and honesty

- Log **every material, externally describable implementation decision**: architecture and dependency choices, changes to behavior or public APIs, data/schema changes, security decisions, trade-offs, assumptions, important rejected alternatives, fixes, and reversals. Log a short, useful rationale; **do not attempt to capture private/internal chain-of-thought**.
- Log **every codebase mutation**: file creation, editing, deletion, renaming, generated code, configuration changes, dependency/lockfile changes, scripts, permissions, tests, and documentation. Include every affected path, even for changes made by automated tools.
- Log every command that can **modify files, dependencies, git state, configuration, or runtime data**, together with its result. For read-only commands, group routine inspections into a short evidence entry; individually log read-only commands when their output directly supports an important decision.
- Log tests/builds/lints/type-checks, failed attempts, incomplete work, blockers, deviations from the plan, and any rollback/revert.
- Do not manufacture decisions, patches, commands, timestamps, checksums, tests, approvals, or results. Use `not_run`, `not_available`, or `unknown` explicitly when appropriate.
- Do not log routine invisible deliberation, every keystroke, or speculative intentions as completed work. Group repeated trivial operations only if the resulting entry still identifies **each affected file** and clearly distinguishes individual outcomes.
- **The user's conversation-turn record in §4.2 is still mandatory**, including when no code changes were made. The detailed audit entries in this section are additional and must be written as work occurs, not reconstructed from memory at the end.

### 8.2 Storage and reviewability

- **Canonical append-only log:** Use ONLY the `$HOME/agent_code_audit/audit.log` (macOS/Linux) or `%USERPROFILE%\agent_code_audit\audit.log` (Windows) path defined in §2.
- **Evidence folder outside the repository:** `$HOME/agent_code_audit/evidence/<repo-identifier>/`. Use a stable safe identifier for the absolute repo root (for example, a short SHA-256 digest of the normalized root path). Create subdirectories `patches/` and `artifacts/` as needed.
- Every recorded decision, command, change, and verification must have a unique `Audit ID` such as `20261010T183000+0530-7f3c`. Link related entries by listing their IDs. Use the real local timestamp with timezone, not a guessed time.
- Each entry must identify the absolute repo root, current git branch or `unknown`, worktree or `main`, and agent name. This is required when multiple repositories share the log.
- **Append-only means append-only.** Never overwrite, truncate, reorganize, or rewrite old entries. If an entry is wrong, append a new `CORRECTION` entry referencing its ID.
- When multiple agents may write concurrently, use OS-supported append semantics or a lock so entries do not interleave. If writing fails, report it immediately; do not silently proceed as though logging succeeded.
- Never commit the external log or audit artifacts to the project repository. Do not add a repository-local logging dependency just to satisfy this policy.
- Never store API keys, passwords, tokens, cookies, `.env` contents, credentials, private keys, sensitive terminal output, or other secrets in the log **or in patch artifacts**. Redact dangerous arguments and outputs. If a safe exact diff cannot be preserved, record the affected path and a redacted change summary; explicitly mark `Patch: omitted_sensitive_content`.

### 8.3 Required workflow for EACH user request

**A. Before editing (baseline)**

1. Verify §3 session start has occurred.
2. Establish the actual repo root, worktree, branch, and (if available) current commit SHA. Inspect `git status --short`, the changed tracked files, and untracked files; do not assume the working tree is clean.
3. Record a `WORK BASELINE` entry including the user request's short objective, existing dirty files, relevant git commit, and intended scope. Redact sensitive paths or content as necessary.
4. Do not discard, stage, overwrite, reformat, or take credit for **pre-existing user changes**. Before editing a dirty file, identify the baseline content or hash so only your new modifications are attributed to you.

**B. Before each material implementation decision or change**

5. Append a `DECISION` entry stating what you chose, why in concise user-facing terms, which requirements it serves, noteworthy alternatives (if material), and expected affected paths. This is a rationale summary, not private reasoning.
6. For risky, destructive, externally visible, or irreversible operations, follow normal user-approval requirements. Recording a decision **does not** authorize the operation by itself.

**C. Immediately after taking an action**

7. Append a `COMMAND` entry for each mutating shell/tool command with sanitized command, directory, exit status, result, and side effects. Include a failure entry if it failed.
8. Append a `CODE CHANGE` entry after each meaningful edit or cohesive set of edits. **List every changed path** with change type (`added`, `modified`, `deleted`, `renamed`, `generated`), its role, concise before/after behavior, and reason. Include SHA-256 before and after when feasible; use `N/A` for files that did not exist or were deleted.
9. Capture review evidence: actual changed lines or a path-scoped unified diff/patch for safe text files, preferably in the external evidence folder. Identify the evidence path in the log. Include staged and unstaged changes as needed; distinguish the agent's edits from any pre-existing changes. If no patch is available, say why.
10. Record dependency version changes, generated files, lockfile changes, API changes, environment/config changes, and migrations explicitly, not just source-code files.
11. If you revert an edit, append a `REVERT`/`CORRECTION` entry describing the original audit ID, affected files, and resulting state. Never erase the earlier entry.

**D. After implementation**

12. Run the relevant checks supported by the project, such as `git diff --check`, lint, unit tests, integration tests, build, and/or end-to-end tests. Append a `VERIFICATION` entry for **each executed command**, including its exact sanitized command, exit code, pass/fail result, and brief output/error summary. If a check is skipped, append `not_run` and why.
13. Compare the final working-tree state to the baseline. Confirm that **every new change is explained** in a `CODE CHANGE` entry. Flag unexplained modifications, pre-existing dirty files, and agent changes that could not be isolated.
14. Append the usual **§4.2 PER-TURN entry** with a 2–5 sentence response summary and references to the audit IDs. Explicitly state `No code changes` when no files were changed.
15. Give the user a short reviewable summary: decisions, files changed, what changed, commands/tests and results, unfinished work, and how to view diffs. Never report a test as passing unless it was actually run and passed.

### 8.4 Audit-entry formats (append these blocks to the §2 audit.log)

**0. New-log initialization (once per newly created audit.log):**

```text
## [ISO-8601 TIMESTAMP] AUDIT LOG CREATED [AUDIT-ID]
Repo Root: <absolute_path>
Agent: <name_or_unknown>
Location: <absolute_path_to_agent_code_audit/audit.log>
```

**A. Work baseline:**

```text
## [ISO-8601 TIMESTAMP] WORK BASELINE [AUDIT-ID]
Repo Root: <absolute_path>
Branch: <branch_or_unknown>
Commit: <sha_or_unknown>
Worktree: <path_or_main>
Agent: <name_or_unknown>
Task: <short requested objective>
Existing Changes: <git status --short summary, including untracked files, or unavailable>
Scope: <files/components intended to inspect or change>
```

**B. Decision (record before implementation):**

```text
## [ISO-8601 TIMESTAMP] DECISION [AUDIT-ID]
Repo Root: <absolute_path>
Branch / Worktree / Agent: <branch> / <worktree> / <agent>
Decision: <specific implementation choice>
Reason: <concise, user-readable rationale and requirement>
Alternatives: <noteworthy options and why not selected, or none>
Expected Impact: <features, behavior, files, risks>
Status: planned
```

**C. Command or tool action:**

```text
## [ISO-8601 TIMESTAMP] COMMAND [AUDIT-ID]
Repo Root: <absolute_path>
Branch / Worktree / Agent: <branch> / <worktree> / <agent>
Command or Tool: <sanitized literal invocation>
Working Directory: <path>
Purpose: <what it was intended to do>
Exit Status: <exit_code | success | failure | unknown>
Result: <short actual outcome and side effects>
Decision IDs: <related IDs or none>
```

**D. Code change (mandatory for every created/edited/deleted/renamed file):**

```text
## [ISO-8601 TIMESTAMP] CODE CHANGE [AUDIT-ID]
Repo Root: <absolute_path>
Branch / Worktree / Agent: <branch> / <worktree> / <agent>
Decision IDs: <related IDs or none>
Files:
- path=<repo-relative-path>; action=<added|modified|deleted|renamed|generated>; before_sha256=<hash|N/A|unknown>; after_sha256=<hash|N/A|unknown>; change=<precise summary>
- path=<another-file>; action=<...>; before_sha256=<...>; after_sha256=<...>; change=<...>
Behavior Before: <what users/code did before, or unknown>
Behavior After: <what it now does, or intended behavior if not verified>
Why: <requirement/bug/decision>
Patch: <external path | git diff command | omitted_sensitive_content | not_available>
Pre-existing Changes: <none | which dirty files were present | unknown>
Status: <applied|partial|failed|reverted>
```

**E. Test/build/review verification:**

```text
## [ISO-8601 TIMESTAMP] VERIFICATION [AUDIT-ID]
Repo Root: <absolute_path>
Branch / Worktree / Agent: <branch> / <worktree> / <agent>
Related Change IDs: <IDs>
Check: <sanitized command or manual inspection>
Result: <PASS|FAIL|NOT_RUN|INCONCLUSIVE>
Exit Code: <integer|N/A>
Evidence: <short output summary, redacted artifact path, or reason not run>
Remaining Risk: <known failure, unchecked platform, or none known>
```

**F. Failure, correction, or revert:**

```text
## [ISO-8601 TIMESTAMP] <FAILURE|CORRECTION|REVERT> [AUDIT-ID]
Repo Root: <absolute_path>
Branch / Worktree / Agent: <branch> / <worktree> / <agent>
Related Audit IDs: <IDs>
What Happened: <observed result>
Impact: <files, behavior, tests>
Resolution: <next action, completed fix, or blocked>
```

**G. No-code-change outcome:** When a turn involved explanation, planning, or read-only inspection, append the normal §4.2 entry and include `Actions: * No code changes` there. Do not invent `CODE CHANGE` entries.

### 8.5 Diff evidence and accurate attribution

- For git-tracked edits, inspect `git diff -- <path>` for unstaged edits and `git diff --cached -- <path>` for staged edits. Inspect `git status --short` and `git diff --name-status` to find additions, deletions, or renames; use equivalent checks for staged changes and untracked files.
- For untracked new files, a normal `git diff` may show nothing. Record the file explicitly; when safe, obtain a new-file patch with a tool such as `git diff --no-index -- /dev/null <file>` (nonzero exit status for a diff is expected), or a before/after diff if applicable.
- Prefer evidence showing **only the modifications performed in the current action**, especially when the working tree had prior uncommitted edits. Do not describe the entire cumulative diff as your own work.
- Where feasible record SHA-256 of the actual files before and after editing, not of just a proposed patch. Record `N/A` for add/delete and `unknown` if the state could not be captured. A hash provides identification, **not** a replacement for a readable summary.
- Never run automatic `git add`, `git commit`, `git reset`, `git clean`, force push, history rewrite, or other destructive git operations merely to produce an audit trail. Use git read-only inspections unless the user requests or authorizes the operation.
- For binary files, huge generated files, or sensitive changes, record metadata and a clear reason why a full diff is omitted. Do not dump binary data or secrets into logs.

### 8.6 Sub-agents, multi-agent tasks, and concurrency

- The parent must pass §2's log location and this section to sub-agents and worktrees. Each agent writes its own `DECISION`, `COMMAND`, `CODE CHANGE`, and `VERIFICATION` entries, and includes `parent_agent` in the ordinary §4.2 turn entry.
- Do not silently merge a sub-agent's changes into an unattributed parent summary. The parent references the child audit IDs and verifies the aggregate diff against the baseline.
- When two agents change the same file, log each independently with the then-current before/after state. Flag conflicts, overwritten changes, and uncertain attribution.
- If an agent or external tool edits files without providing a detailed record, audit the resulting changed paths, mark the source as `external_or_unknown`, and do not fabricate the reason.

### 8.7 User-facing change report (required for code-editing tasks)

At the end of a coding turn, report briefly:

1. **Decisions made:** major choices with reasons.
2. **Files changed:** every affected path or a clearly linked audit index if there are many, with the nature of changes.
3. **Commands and validation:** what actually ran, pass/fail, and what was not tested.
4. **Issues and remaining work:** blockers, regressions, warnings, and unresolved requirements.
5. **How to review:** log path, safe patch path (if generated), plus appropriate `git diff`/`git status` commands.

**Do not claim that merely writing a rule in `AGENTS.md` guarantees a tool obeyed it.** The audit exists only if the agent actually writes the entries and captures the relevant evidence. When the user needs stronger guarantees, suggest git commits with user approval, CI checks, or a dedicated auditing script/hook.

### 8.8 Quick commands for the user to review the work

On macOS/Linux:

```bash
tail -n 150 "$HOME/agent_code_audit/audit.log"
git status --short
git diff --stat
git diff
```

On Windows PowerShell:

```powershell
Get-Content "$env:USERPROFILE\agent_code_audit\audit.log" -Tail 150
git status --short
git diff --stat
git diff
```

The log records **why** a change was made and **what was attempted**. The working tree and saved safe diff evidence show **what is actually different**. Read both before reviewing or reverting changes.

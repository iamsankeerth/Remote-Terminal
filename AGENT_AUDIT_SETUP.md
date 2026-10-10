# Setup Guide: AGENTS.md with Independent Codebase Audit Logging

This guide accompanies the updated `AGENTS.md`. It does **not** create or modify the old MLE Hiring log.

## What changed

The agent is instructed to create a brand-new log automatically on first use:

| System | New audit log | Optional patch/evidence directory |
|---|---|---|
| Windows | `%USERPROFILE%\agent_code_audit\audit.log` | `%USERPROFILE%\agent_code_audit\evidence\` |
| macOS/Linux | `$HOME/agent_code_audit/audit.log` | `$HOME/agent_code_audit/evidence/` |

The **same** log contains conversation summaries, implementation decisions, code-change records, shell/tool commands, verification results, errors, and corrections. Entries include repo and agent identifiers, so several projects can share this log. It is append-only.

The prior `mle_hiring/log.txt` is never used, read, migrated, or modified. The old onboarding agreement does not carry over to the new log.

## Requirements

1. **An AGENTS.md-aware coding agent**, such as OpenCode, running in the repository. The Markdown file is an instruction file, not an executable program. OpenCode loads `AGENTS.md` from the project directory.
2. **Read/write access to your code repository** so the agent can work on code and document changes.
3. **Access to your home directory's `agent_code_audit` folder.** This location is outside the repository. Approve a narrowly scoped external-directory permission request when OpenCode asks. The agent must be able to create folders and append to `audit.log`.
4. **Git installed and a Git repository initialized** for meaningful change attribution, `git status`, and `git diff`. Without Git, logging can still operate, but some diff/baseline evidence is unavailable.
5. **A terminal or shell tool** enabled for the agent, so it can inspect the repository, produce diffs, and run validation commands. Approve only necessary operations.
6. **Project-specific runtime/dependencies** to actually build and test code. For a JavaScript project this usually includes Node.js and npm. `AGENTS.md` itself requires neither npm nor a Node.js package to execute.
7. **A coding model that follows instructions reliably.** The audit rules guide the agent but are not tamper-proof or guaranteed by OpenCode itself.

## Windows PowerShell setup

1. Download `AGENTS.md` and place it in **your project root**. Replace the older `AGENTS.md` if you're updating the same project, after keeping a backup if you need one.
2. Open a PowerShell terminal and navigate to your project:

   ```powershell
   cd C:\path\to\your\repository
   git status --short
   opencode
   ```

3. Tell OpenCode:

   > Read AGENTS.md completely. Initialize the **new** `%USERPROFILE%\agent_code_audit\audit.log` if missing, and confirm the absolute path. Do not access the old MLE Hiring log. Before modifying code, show the current Git baseline and record it in the new audit log. Follow the onboarding requirements in AGENTS.md.

4. Allow the agent to create/write to the new audit folder if OpenCode asks for external-directory access.
5. If `AGENTS.md` asks for first-time agreement, reply `I agree`. This is a rule in your existing challenge-specific file, not an OpenCode built-in requirement.
6. Ask the agent to implement a small, reversible change and log its decision, affected file, command and verification evidence.

### Check the audit log exists

```powershell
Test-Path "$env:USERPROFILE\agent_code_audit\audit.log"
Get-Content "$env:USERPROFILE\agent_code_audit\audit.log" -Tail 80
```

The first command should output `True` **after the agent successfully initializes the log**. The second displays recent entries.

### Compare against real code changes

```powershell
git status --short
git diff --stat
git diff
git diff --cached
```

Use Git evidence in addition to the agent's log; don't rely on the log alone.

## macOS/Linux setup

Put `AGENTS.md` in the repo root, start OpenCode **from that repo**, grant narrow access to `$HOME/agent_code_audit/` if prompted, and check:

```bash
ls -l "$HOME/agent_code_audit/audit.log"
tail -n 80 "$HOME/agent_code_audit/audit.log"
git status --short
git diff
```

## Optional: OpenCode access configuration

OpenCode's permission format **depends on whether you use V1 or V2**. When possible, simply approve a narrowly scoped request for your audit folder instead of granting broad filesystem access.

If you configure permissions manually, consult the official guide for your version:

- Rules: https://opencode.ai/docs/rules/
- Current V1-style permissions: https://dev.opencode.ai/docs/permissions/
- V2-style permissions: https://opencode.ai/v2/docs/permissions

For V2, the relevant permission action is `external_directory`; for V1, it is `permission.external_directory`. Be sure that the agent is also permitted to write files and execute the necessary commands.

## Important context: your current AGENTS.md is challenge-specific

Your supplied `AGENTS.md` contains MLE Hiring Challenge instructions, a challenge onboarding gate, the support-ticket evaluator contract, and an **expired May 30, 2026 deadline**. Those sections were deliberately preserved when updating the audit-log path. If you're applying these rules to a different repository (such as a remote terminal app), remove or rewrite the challenge-specific sections first. The auditing rules can be reused independently.

## Limits of instruction-based auditing

`AGENTS.md` cannot force a buggy, interrupted, or noncompliant agent to log every action. A command may fail before a log entry is written, and Git alone cannot explain why a change was made. For higher assurance, review the `audit.log`, the evidence folder, `git diff`, and your Git history, and consider an independently enforced hook or script.

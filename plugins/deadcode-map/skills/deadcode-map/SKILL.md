---
name: deadcode-map
description: Find dead code in a JS/TS or Python repo, prove it is dead, and clean it up safely. Use when the user asks to find unused code, remove dead code, check what is safe to delete, or see a map of dead code in their project. Triage SAFE first, prove before deleting, never auto-delete REVIEW.
---

# deadcode-map

Find dead code, **prove** it is dead, and **see it on a map**. JS / TypeScript and Python. Every finding is graded `SAFE` / `REVIEW` / `KEEP` and carries its evidence: importers, callers, string mentions, git age, test coverage.

## Workflow

### 1. Scan first

Use the `scan_repo` MCP tool on the project directory, or the CLI:

```sh
deadcode-map [path] --json report.json
deadcode-map [path] --json -    # JSON report on stdout, for piping
```

`scan_repo` returns at most 100 findings. For the full list, use the CLI `--json` output. Default grade filter is `REVIEW`, which returns SAFE + REVIEW. KEEP findings are live code and are hidden from the summary.

### 2. Triage SAFE first

- **SAFE** — provably dead: 0 importers, 0 callers, no string references, not an entry point, not framework magic. Safe to delete after proving.
- **REVIEW** — probably dead, but a human must check: exported symbols, methods, anything with a string mention or dynamic import nearby. Never auto-delete.
- **KEEP** — live code. Leave it alone.

For any finding you are unsure about, call `explain_finding` with its id. It returns the full record: all evidence fields plus the exact delete diff.

### 3. Prove before deleting

Run the CLI `--prove` step before deleting. It deletes SAFE candidates in an isolated git worktree, runs the test suite once per file cluster, and reports `proven` / `breaks` / `skipped`:

```sh
deadcode-map [path] --prove
deadcode-map [path] --prove --test-command "pytest -q"
```

If `--prove` reports a break, do not delete that cluster. If the repo has no test command, say so and fall back to a careful manual review of the `explain_finding` evidence instead of deleting blind.

### 4. Delete SAFE only

Use the `fix_safe` MCP tool with `confirm: true`, or the CLI:

```sh
deadcode-map [path] --fix
```

`fix_safe` and `--fix` act on SAFE findings only. They never touch REVIEW or KEEP. After deleting, run the test suite and show the user the `git diff` for review before committing.

### 5. See the map

Call `get_map` for a summary, then read the full interactive HTML map from the `deadcode://map/{path}` resource (red = SAFE, amber = REVIEW, green = live). Or write it with the CLI:

```sh
deadcode-map [path] --map deadcode-map.html
```

## Rules

- Never delete a REVIEW finding without asking the user first.
- Never delete KEEP.
- Never run `--fix` with `--include-review` unless the user explicitly asked for it.
- Baseline first in CI: `deadcode-map --update-baseline` records current findings in `.deadcode-map.json`; `deadcode-map --baseline --fail-on safe` then fails only on new SAFE dead code.
- Fixture and test-data directories (`fixtures/`, `__fixtures__/`) are excluded from scans by default. Use `--include-fixtures` (or `includeFixtures: true` in `scan_repo`) only when the user asks to scan them.
- If a scan returns 0 findings, say so plainly — do not invent dead code.

## Status check

`status` is the cheap call when you only need counts: findings by grade, whether a `.deadcode-map.json` baseline exists, whether the directory is a git repo, and the detected test command. No finding list.

## Reference

- Grades and evidence: each finding has `grade`, `reason`, and `evidence` (`importers`, `callers`, `stringRefs`, `exported`, `coveragePct`, `gitAgeDays`, `gitLastCommit`, `gitCommits`).
- CLI exit codes: 0 ok, 1 `--fail-on` triggered, 2 usage error / no such directory.
- The web checker at https://ashudhanda.github.io/deadcode-map/ is a lightweight regex-based analyzer, not the full engine. Prefer the MCP tools or the CLI for real decisions.

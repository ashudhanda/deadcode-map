# AGENTS.md — deadcode-map

Guide for CLI agents (human or AI) working in this repo.

## What this repo is

deadcode-map finds dead code, proves it is dead, and shows it on a map.
JS / TypeScript, Python, and Java (private-only SAFE, off by default —
opt in with `--java-safe` while measuring; see README "Java scope").
Every finding is graded `SAFE` / `REVIEW` / `KEEP`
and carries its evidence (importers, callers, string mentions, git age, coverage).
`--fix` / `--prove` act on SAFE only. The map is a single self-contained HTML file.

- `src/discover.js` — file walk + entry-point detection.
- `src/parse-js.js`, `src/parse-py.js` — tree-sitter parsers.
- `src/graph.js` — import resolution + reachability from entry points.
- `src/confidence.js` — SAFE / REVIEW / KEEP grading with evidence.
- `src/git.js`, `src/coverage.js` — git age/churn and Cobertura coverage evidence.
- `src/map.js` — single-file offline HTML map.
- `src/fix.js` — SAFE-only deletion, one file at a time.
- `src/prove.js` — isolated git worktree + test run.
- `src/baseline.js` — `.deadcode-map.json` grandfathering for CI.
- `src/mcp-server.js` — MCP server (stdio): tools `scan_repo`, `explain_finding`,
  `fix_safe`, `get_map`, `status`; prompt `cleanup-dead-code`; resource
  `deadcode://map/{path}`. Stdout is the JSON-RPC channel — never `console.log`
  in MCP mode, `console.error` only.
- `plugins/deadcode-map/` — Claude Code plugin (skill, slash command, MCP launcher).
- `docs/` — web checker (regex-based analyzer, not the full engine).
- `fixtures/` — planted dead items + known live items. Fixture directories are
  excluded from scans by default; use `--include-fixtures` to scan them.

## How to run things

```sh
npm install          # install dependencies (Node 18+)
npm test             # fixtures + CLI + MCP tests (node --test)
node --test test/web-analyzer.test.js   # web checker tests
node bin/deadcode-map.js .              # dogfood: scan this repo
npm run mcp          # start the MCP server on stdio
```

## Dogfood

Run the tool on itself before claiming a change is clean:

```sh
node bin/deadcode-map.js .
```

It must report **0 findings**. If your change introduces a finding, fix the
code (or the analyzer) — do not add a baseline to hide it. With
`--include-fixtures` the planted fixture data still reports (413 findings,
0 in `src/`); that is expected.

## Rules for changes

- English only in code, comments, log messages, and docs. No other language
  anywhere in the repo.
- CommonJS only (`"type": "commonjs"`). Do not convert the repo to ESM.
- Keep the SAFE false-positive rate at 0% on the fixtures: every live symbol
  in `fixtures/` must never be flagged SAFE, every planted dead item must be
  found at SAFE or REVIEW. `npm test` enforces this.
- `--fix` and `fix_safe` are SAFE-only, always. Never widen them to REVIEW
  without an explicit user request, and never silently.
- Java policy (batch 10, see README "Java scope"): a private
  constructor of an all-static utility class is KEEP — it is an
  instantiation guard, not dead code (deleting it exposes a public
  default constructor). A private enum constructor no constant
  invokes is KEEP (the constructor is the wrong deletion unit for
  an enum); one the constants do invoke is live and gets no finding.
  Private Java serialization callbacks (`readObject` / `writeObject`
  arity 1, `readObjectNoData` / `readResolve` / `writeReplace` arity
  0) are KEEP — the runtime invokes them by reflection. An unused
  local whose initializer calls a method or creates an object is
  REVIEW, never SAFE — the call may have side effects; a pure unused
  local (`int x = 1;`) stays SAFE. The same rule applies to private
  fields (batch 11): an unused private field whose initializer calls
  a method or creates an object is REVIEW, never SAFE — the call runs
  when the class loads / an instance is created, so deleting the
  declaration would remove the call; a pure unused field stays SAFE.
- The HTML map must stay single-file and offline: no CDN, no external scripts.
- Do not break existing CLI flags or exit codes (0 ok, 1 `--fail-on`
  triggered, 2 usage error / no such directory).
- Verify MCP changes with `node --test test/mcp.test.js` (spawns the real
  server over stdio, no network).

# deadcode-map

Find dead code, **prove** it is dead, and **see it on a map**.

Most dead-code tools print a list and walk away. deadcode-map does three things they don't:

1. **Confidence + evidence, not a boolean.** Every finding is graded `SAFE` / `REVIEW` / `KEEP` and carries its evidence: 0 importers, 0 callers, last git touch, test coverage, string mentions.
2. **The map is the product.** `deadcode-map --map` writes a single self-contained HTML file (no CDN, no server — open it by double-clicking). Dead nodes are red, review is amber, live is green. Click a node for why it was flagged, who doesn't call it, its git age, coverage, and the exact delete diff.
3. **Prove, don't just list.** `deadcode-map --prove` deletes SAFE candidates in an isolated git worktree, runs your test suite once per file-cluster, and reports `proven` / `breaks` / `skipped`. It bisects only if a cluster fails.

JS / TypeScript and Python in v1, one command, one mental model. Java (private-only) is next.

## Install

```sh
npm install -g deadcode-map
# or, without installing:
npx deadcode-map [path]
```

Requires Node.js 18+. The target repo needs no runtime: source is parsed with tree-sitter, never executed.

## Usage

```sh
deadcode-map [path]                 # scan the current directory
deadcode-map ./my-app --map deadcode-map.html
deadcode-map ./my-app --json report.json
deadcode-map ./my-app --fail-on safe        # CI: exit 1 on new SAFE dead code
deadcode-map ./my-app --baseline            # hide grandfathered findings
deadcode-map ./my-app --update-baseline     # record current findings as baseline
deadcode-map ./my-app --fix                 # delete SAFE findings only
deadcode-map ./my-app --prove               # prove SAFE deletions with your tests
deadcode-map ./my-app --prove --test-command "pytest -q"
deadcode-map ./my-app --include-fixtures    # also scan fixtures/ test-data dirs (excluded by default)
deadcode-map mcp                            # start the MCP server on stdio (for AI tools)
```

## Use with AI tools

deadcode-map ships an MCP server (stdio) so AI coding tools can scan, explain, and safely clean up dead code in your repo. It exposes five tools — `scan_repo`, `explain_finding`, `fix_safe`, `get_map`, `status` — plus a `cleanup-dead-code` prompt and a `deadcode://map/{path}` resource serving the visual HTML map. `fix_safe` deletes SAFE findings only and refuses unless you pass `confirm: true`; it never touches REVIEW or KEEP. Requires Node.js 18+.

### Claude Code (plugin)

```sh
/plugin marketplace add ashudhanda/deadcode-map
/plugin install deadcode-map@deadcode-map
```

This installs the MCP server, the `deadcode-map` skill, and the `/deadcode-map` slash command. For local development without installing:

```sh
claude --plugin-dir ./deadcode-map
```

Or wire the MCP server by hand in `.mcp.json` (project) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "deadcode-map": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "deadcode-map", "mcp"]
    }
  }
}
```

### Claude Desktop

Add to `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%/Claude/` on Windows, `~/.config/Claude/` on Linux), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "deadcode-map": {
      "command": "npx",
      "args": ["-y", "deadcode-map", "mcp"]
    }
  }
}
```

### Codex CLI

In `~/.codex/config.toml`:

```toml
[mcp_servers.deadcode-map]
command = "npx"
args = ["-y", "deadcode-map", "mcp"]
```

Or add it from the command line (note: `env` does no `${VAR}` expansion in Codex — use `env_vars` to forward host variables):

```sh
codex mcp add deadcode-map -- npx -y deadcode-map mcp
```

### Cursor

In `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). Cursor requires `"type": "stdio"` on stdio entries:

```json
{
  "mcpServers": {
    "deadcode-map": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "deadcode-map", "mcp"]
    }
  }
}
```

### Windsurf

Open the MCP config from inside Windsurf (Settings → MCP Servers) and add:

```json
{
  "mcpServers": {
    "deadcode-map": {
      "command": "npx",
      "args": ["-y", "deadcode-map", "mcp"]
    }
  }
}
```

The config file lives at `~/.config/devin/mcp_config.json` (current; older installs used `~/.codeium/windsurf/mcp_config.json`).

### VS Code Copilot

In `~/.copilot/mcp-config.json` (global) or a workspace `.mcp.json`:

```json
{
  "mcpServers": {
    "deadcode-map": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "deadcode-map", "mcp"]
    }
  }
}
```

(Deprecated: `.vscode/mcp.json` with top-level `servers` — use the format above instead.)

### Gemini CLI

In `~/.gemini/settings.json` or a project `.gemini/settings.json` (env vars expand as `$VAR` / `${VAR}`). Verify with `/mcp list`:

```json
{
  "mcpServers": {
    "deadcode-map": {
      "command": "npx",
      "args": ["-y", "deadcode-map", "mcp"]
    }
  }
}
```

### OpenCode (v2)

In `opencode.json`. Note the v2 shape: `mcp.servers`, `type: "local"`, `command` is one array, env vars go under `environment`:

```json
{
  "mcp": {
    "servers": {
      "deadcode-map": {
        "type": "local",
        "command": ["npx", "-y", "deadcode-map", "mcp"],
        "environment": {},
        "disabled": false
      }
    }
  }
}
```

### Generic CLI agents (no MCP)

Any agent that can run shell commands can use the CLI directly — no MCP setup needed:

```sh
deadcode-map [path] --json -            # full JSON report on stdout (pure JSON, no terminal summary)
deadcode-map [path] --json report.json  # or write it to a file
deadcode-map [path] --map deadcode-map.html
deadcode-map [path] --fail-on safe      # CI: exit 1 on new SAFE dead code
deadcode-map [path] --baseline          # hide findings already in .deadcode-map.json
deadcode-map [path] --update-baseline   # record current findings as the baseline
deadcode-map [path] --prove             # prove SAFE deletions with your tests first
deadcode-map [path] --fix               # delete SAFE findings only
```

Exit codes: 0 ok, 1 `--fail-on` triggered, 2 usage error / no such directory. A repo guide for agents lives in [AGENTS.md](AGENTS.md).

Example output:

```
deadcode-map  /home/ashu/my-app
  34 findings — 2 SAFE · 25 REVIEW · 7 KEEP (hidden)
  SAFE dead code: ~74 bytes across 2 findings
  by category: file 5, function 22, import 1, unreachable 1, class 1, method 4

  SAFE   src/used.js:1 unusedImport
         imported "unusedImport" from "./helper" but never referenced in this file
  SAFE   src/used.js (unreachable)
         code after return/throw/break/continue
```

## Try it in the browser (no install)

Paste a public GitHub repo link at **https://ashudhanda.github.io/deadcode-map/** and check
dead code in the browser: summary counts, per-file findings, and a visual map. Your repo is
fetched straight from GitHub in your browser — nothing is uploaded anywhere. An optional
GitHub token raises the API rate limit from 60 to 5,000 requests/hour; it is kept only in
memory and never stored.

Honest limit: the web checker is a lightweight regex-based analyzer, not the full
tree-sitter CLI. It covers JS/TS and Python, caps at 500 files / 5 MB, and handles public
repos only. For full accuracy, `--prove`, and `--fix`, use the CLI above.

## What counts as dead

| Category | Definition |
|---|---|
| Dead file | No importer, not an entry point, not referenced by name anywhere |
| Dead export / function / class | Defined/exported, 0 importers/callers in the repo |
| Dead import / variable | Imported/declared, never referenced in its scope |
| Unreachable code | Code after `return` / `throw` / `break` / `continue`, `if (false)` branches |
| Dead dependency (JS) | In `package.json`, never imported/required, named in a script, or referenced by a code/config string — README prose does not count |

## What is never flagged SAFE

- **Entry points**: `package.json` main/bin/exports, `src/index` / `src/main`, `if __name__ == "__main__"` scripts, shebang CLI scripts, framework routes (`pages/`, `app/`), tests, stories, config, migrations.
- **Framework magic**: route handlers (`@app.route`, Next.js `getServerSideProps`), decorators, dunder / protocol methods (`__init__`, `__str__`), module dunder variables (`__version__`, `__author__`, `__all__` — read by the import system / packaging tooling), `__init__.py` re-exports. Framework rules live in `frameworks/*.json` and are loaded by default.
- **Dynamic use**: anything in a file that uses dynamic `import()`, `require(variable)`, `importlib`, or `getattr` is REVIEW at most — never SAFE.
- **Public API of a published library**: exported symbols are REVIEW, never SAFE, never auto-deleted.
- **Methods**: a method with 0 in-repo callers is REVIEW at most — it could be called via an object or a framework.
- **Same-file use is alive**: a symbol called or referenced in its own file is never flagged — it is used, even if nothing else in the repo imports it.
- **Fixture / test-data directories are not scanned by default**: `fixtures/`, `__fixtures__/` at any depth (`test/fixtures`, `tests/fixtures`, …) are excluded — planted dead code in test data is not real dead code. Use `--include-fixtures` (CLI) or the checkbox in the web checker to scan them.

## False-positive defences (in priority order)

1. A real import/call graph built from entry points — no flat name-matching.
2. A string-reference pass: the symbol name is searched across the whole repo (code, config, templates) before flagging. Only code-like mentions count — the name as a whole string (`'named'`, `{"handler": "wired"}`) or delimited by code characters (`'handlers.named'`, `'./named'`). Words inside sentences (`'a named export is nice'`, a docstring, README prose) do not count, and `.md` / `.txt` files never count.
3. Dynamic-import / reflection detection downgrades to REVIEW.
4. Framework rule packs as data files (`frameworks/next.json`, `frameworks/fastapi.json`, …).
5. Confidence grading + `--min-confidence`; `--fix` / `--prove` act on SAFE only.
6. Baseline (`.deadcode-map.json`) + inline ignore (`// deadcode-map-ignore-next`, `# deadcode-map: ignore` — planned, see Roadmap).
7. `prove` as the final arbiter: if the tests pass without it, it is dead.

## Measured results (checkable, not marketing)

Fixtures live in `fixtures/` with planted dead items and known live items. Run them with `npm test`.

| Fixture | Files | SAFE found | SAFE false positives | SAFE FP rate |
|---|---|---|---|---|
| `js-basic` (JS, CommonJS + ESM) | 9 | 4 | 0 | **0%** |
| `py-basic` (Python, Flask + pytest) | 6 | 2 | 0 | **0%** |
| `py-relative` (Python, relative imports) | 7 | 1 | 0 | **0%** |
| `py-imports` (Python, dotted imports + module dunders) | 4 | 1 | 0 | **0%** |
| `py-multiline` (Python, parenthesized + backslash imports) | 2 | 3 | 0 | **0%** |
| `js-string` (JS, prose vs code-like string mentions) | 6 | 2 | 0 | **0%** |
| `py-string` (Python, docstring prose vs code-like mentions) | 4 | 1 | 0 | **0%** |
| `js-deps` (JS, dead dependencies: README prose vs real imports) | 5 | 0 | 0 | **0%** |
| `js-framework` (Next.js `pages/`) | 1 | 0 | 0 | **0%** |

The web checker (`docs/analyzer.js`, regex-based) reproduces the same SAFE findings on every fixture above, including the dead Python import in `py-imports` — verified by `test/web-analyzer.test.js` (21 tests).

Dogfood — deadcode-map run on itself: **0 findings**. The repo scans clean: fixture/test-data directories are excluded by default, same-file use counts as alive, and the one genuinely dead helper (`named` in `src/parse-js.js`) was deleted. With `--include-fixtures` the planted fixture data still reports (44 findings, 0 in `src/`), which is the point of the fixtures.

A real-repo check on a Python project (a Raspberry Pi / Arduino gateway script) first flagged the runnable `__main__` script as a dead file — that false positive is now a regression test (`run.py` in `py-basic`), and the same repo now reports 0 SAFE.

Known limitation, stated honestly: a name that appears as a whole string or a code-delimited string still counts as a reference, even when the string is not a real dynamic lookup — for example a test file asserting on the symbol by name (`bySymbol(f, 'src/index.js', 'render')`). Those findings land in REVIEW, never SAFE, so the cost is noise, not a false deletion. The same shape applies to the dead-dependency check: a dependency named in a config value (e.g. `"theme": "chalk"`) counts as used, and a dependency name that is a prefix of a longer hyphenated name (`left-pad` inside `left-pad-x`) can also count — both are REVIEW noise, never a false deletion.

## How it works

```
discover  →  parse (tree-sitter)  →  import/call graph  →  confidence + evidence
     ↑ git age / churn                     ↑ string-reference pass
     ↑ coverage.xml (if present)           ↑ framework packs
     └─→ CLI / JSON / --fail-on / baseline ─→ HTML map ─→ --fix ─→ --prove
```

- `src/discover.js` — file walk + entry-point detection.
- `src/parse-js.js`, `src/parse-py.js` — tree-sitter parsers (imports, exports, definitions, calls, dynamic imports, unreachable code, decorators).
- `src/graph.js` — import resolution (relative, ESM, CommonJS `require`, dynamic `import()`, Python sibling modules), reachability from entry points, per-symbol usage.
- `src/confidence.js` — SAFE / REVIEW / KEEP grading with evidence.
- `src/git.js`, `src/coverage.js` — git age/churn and Cobertura coverage evidence.
- `src/map.js` — single-file offline HTML map (canvas force graph, no CDN).
- `src/fix.js` — SAFE-only deletion, one file at a time.
- `src/prove.js` — isolated git worktree + test run, batched by file cluster, bisect on failure.
- `src/baseline.js` — `.deadcode-map.json` grandfathering for CI.

## Roadmap

- v0.1.0 (shipped): MCP server + Claude Code plugin + AI-tool configs (see "Use with AI tools").
- v1.1: Java, private methods/fields/classes only (public Java is REVIEW-only — it cannot be proven statically).
- Framework packs: Django, Angular, Spring, pytest (more), Vue, Svelte.
- `--diff` / `--since` for PRs: "what did *this PR* leave dead?"
- Inline ignore comments (`// deadcode-map-ignore-next`).
- Interactive approve / reject / keep-with-reason in the map.

## Why this exists

Knip (~13k stars) is the JS/TS incumbent and Vulture (~5k) is the Python standard, but both are terminal lists with well-documented false positives on dynamic imports, lazy loading, and framework code — and neither proves a deletion is safe or shows you a map. deadcode-map wins on prove + map + multi-language + false-positive-first trust. If v1 were just a terminal list, it would not ship.

## License

MIT. See [LICENSE](LICENSE).

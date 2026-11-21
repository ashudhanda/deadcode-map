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
```

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

## What counts as dead

| Category | Definition |
|---|---|
| Dead file | No importer, not an entry point, not referenced by name anywhere |
| Dead export / function / class | Defined/exported, 0 importers/callers in the repo |
| Dead import / variable | Imported/declared, never referenced in its scope |
| Unreachable code | Code after `return` / `throw` / `break` / `continue`, `if (false)` branches |
| Dead dependency (JS) | In `package.json`, the name appears nowhere — no import, require, string, or script |

## What is never flagged SAFE

- **Entry points**: `package.json` main/bin/exports, `src/index` / `src/main`, `if __name__ == "__main__"` scripts, shebang CLI scripts, framework routes (`pages/`, `app/`), tests, stories, config, migrations.
- **Framework magic**: route handlers (`@app.route`, Next.js `getServerSideProps`), decorators, dunder / protocol methods (`__init__`, `__str__`), `__init__.py` re-exports. Framework rules live in `frameworks/*.json` and are loaded by default.
- **Dynamic use**: anything in a file that uses dynamic `import()`, `require(variable)`, `importlib`, or `getattr` is REVIEW at most — never SAFE.
- **Public API of a published library**: exported symbols are REVIEW, never SAFE, never auto-deleted.
- **Methods**: a method with 0 in-repo callers is REVIEW at most — it could be called via an object or a framework.
- **Same-file-only use is not dead**: an export used only in its own file is REVIEW as "unexport-to-local", not a deletion candidate.

## False-positive defences (in priority order)

1. A real import/call graph built from entry points — no flat name-matching.
2. A string-reference pass: the symbol name is searched across the whole repo (code, config, templates) before flagging.
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
| `js-framework` (Next.js `pages/`) | 1 | 0 | 0 | **0%** |

Dogfood — deadcode-map run on itself (36 findings, 0.5s):

| | Count |
|---|---|
| SAFE | 2 — both in the fixtures (a dead import, unreachable code), 0 in `src/` |
| REVIEW | 27 — all correct: exported-but-unused, same-file-only, string-referenced |
| KEEP | 7 — Next.js routes, Flask handlers, test functions, dunder methods |

A real-repo check on a Python project (a Raspberry Pi / Arduino gateway script) first flagged the runnable `__main__` script as a dead file — that false positive is now a regression test (`run.py` in `py-basic`), and the same repo now reports 0 SAFE.

Known limitation, stated honestly: the string pass can over-match common words — a helper called `named` is mentioned as the string `'named'` in another file. Those findings land in REVIEW, never SAFE, so the cost is noise, not a false deletion.

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

- v1.1: Java, private methods/fields/classes only (public Java is REVIEW-only — it cannot be proven statically).
- Framework packs: Django, Angular, Spring, pytest (more), Vue, Svelte.
- `--diff` / `--since` for PRs: "what did *this PR* leave dead?"
- Inline ignore comments (`// deadcode-map-ignore-next`).
- Interactive approve / reject / keep-with-reason in the map.

## Why this exists

Knip (~13k stars) is the JS/TS incumbent and Vulture (~5k) is the Python standard, but both are terminal lists with well-documented false positives on dynamic imports, lazy loading, and framework code — and neither proves a deletion is safe or shows you a map. deadcode-map wins on prove + map + multi-language + false-positive-first trust. If v1 were just a terminal list, it would not ship.

## License

MIT. See [LICENSE](LICENSE).

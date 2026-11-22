---
description: Scan the current project for dead code with deadcode-map and report the counts by grade.
---

# /deadcode-map

Scan the current project for dead code.

1. Run the `scan_repo` MCP tool on the current project directory (default grade filter `REVIEW`, which returns SAFE + REVIEW). If the MCP server is not available, run `deadcode-map . --json -` and parse the JSON report from stdout.
2. Report the counts by grade (SAFE / REVIEW / KEEP) and the total SAFE bytes. List the SAFE findings first (file, symbol, reason), then the REVIEW findings, capped at 10 each — point at the full `--json` report or the map for the rest.
3. Do not delete anything. If the user wants cleanup, follow the deadcode-map skill workflow: explain, prove with `--prove`, then delete SAFE only with `fix_safe` (confirm required).
4. If the scan finds nothing, say the repo is clean and stop.

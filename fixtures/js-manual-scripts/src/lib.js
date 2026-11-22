function usedFn() { return 1; }

// A genuinely dead function in ordinary source: still SAFE. The
// scripts/ heuristic is scoped to scripts/ and tools/ only.
function deadFn() { return 2; }

module.exports = { usedFn };

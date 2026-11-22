function usedFn() { return 1; }

// Dead is never constructed, imported, or referenced anywhere: its
// method never runs, so the helper only that method calls is dead too.
class Dead {
  doDeadWork() { return deadHelper(); }
}

function deadHelper() { return 2; }

module.exports = { usedFn };

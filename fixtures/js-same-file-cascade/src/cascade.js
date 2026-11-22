// Same-file cascade: a helper used only by a dead function is dead too;
// a helper used by a live function is live.

function deadOuter() {
  return deadInner();
}

function deadInner() {
  return 1;
}

function liveOuter() {
  return liveInner();
}

function liveInner() {
  return 2;
}

function topCalled() {
  return topHelper();
}

function topHelper() {
  return 3;
}

topCalled();

function selfOnly(n) {
  return n <= 0 ? 0 : selfOnly(n - 1);
}

function ping() {
  return pong();
}

function pong() {
  return ping();
}

// A variable initializer runs in the enclosing scope: this alias keeps
// aliased() alive even though the alias itself is only read below.
function aliased() {
  return 4;
}

const alias = aliased;
alias();

module.exports = { liveOuter };

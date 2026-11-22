function usedFn() {
  return 'used';
}

function neverCalled() {
  return 'dead export in a library';
}

function privateDead() {
  return 'dead local in a library';
}

const UNUSED_CONST = 1;

module.exports = { usedFn, neverCalled, UNUSED_CONST };

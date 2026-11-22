function usedFn() {
  return 'used';
}

function neverCalled() {
  return 'dead export in an app';
}

function privateDead() {
  return 'dead local in an app';
}

const UNUSED_CONST = 1;

module.exports = { usedFn, neverCalled, UNUSED_CONST };

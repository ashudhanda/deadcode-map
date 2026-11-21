const { unusedImport } = require('./helper');

function usedFn(n) {
  return privateUsed(n) * 2;
}

function privateUsed(n) {
  return n + 1;
}

function privateDead(n) {
  return n * 99;
}

function afterReturn() {
  return 1;
  console.log('this line never runs');
}

module.exports = { usedFn, unusedExport, privateDead, afterReturn };

function unusedExport() {
  return 'never imported anywhere';
}

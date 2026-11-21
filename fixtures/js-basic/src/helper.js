function helper() {
  return sameFileOnly();
}

function sameFileOnly() {
  return 'only used in this file';
}

module.exports = { helper, sameFileOnly };

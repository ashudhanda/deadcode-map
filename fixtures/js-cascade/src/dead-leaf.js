function leafFn() {
  return 'only ever called by dead code';
}

module.exports = { leafFn };

async function loadLazy() {
  const mod = await import('./lazy-target.js');
  return mod.lazyFn();
}

module.exports = { loadLazy };

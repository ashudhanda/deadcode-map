// Classic global script (Django admin JS shape): no imports, no
// exports, no module syntax. Loaded with the other scripts on the same
// page; its top-level functions are globals the other scripts call.
function globalFn() {
  return 'global';
}

function deadGlobal() {
  return 'dead';
}

function clash() {
  return 'core';
}

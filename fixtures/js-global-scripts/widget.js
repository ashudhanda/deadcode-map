/*global globalFn, clash */
// Classic script: calls the global from core.js, and defines its own
// function with the same name as one in core.js.
function clash() {
  return 'widget';
}

console.log(globalFn());

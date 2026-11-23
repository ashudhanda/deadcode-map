// Same hazard from another file: the method call here must not keep
// this file's dead local alive, and must not keep gate.js's `foo`
// alive either (a variable local cannot be used from another file).
const obj2 = { foo() { return 5; } };

function helper() {
  const foo = 99; // dead local: only obj2.foo() shares the name
  return obj2.foo();
}

// The opposite direction: a method CAN escape through a returned
// object and be called cross-file as a member (the tool's own
// cacheCtx pattern), so method locals keep their cross-file credit.
function createCtx() {
  return {
    ping() { return 6; },
  };
}

module.exports = { helper, createCtx };

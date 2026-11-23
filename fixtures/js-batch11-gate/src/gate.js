// Batch 11 gate fixture (hand-written): a dead local named after a
// called method must still be found — a member call `obj.foo()`
// names the member, not the local `foo`.
const { helper, createCtx } = require('./other');

const obj = {
  foo() { return 1; },
  qux() { return 2; },
  get slots() { return 3; }, // live accessor: read as a property below, never called
};

function outer() {
  const foo = 42;               // dead local: only obj.foo() shares the name
  const bar = 7;                // live local: read bare below
  function baz() { return 3; }  // live local function: called bare below
  function qux() { return 4; } // dead local function: only obj.qux() shares the name
  return obj.foo() + obj.qux() + bar + baz() + helper() + createCtx().ping() + obj.slots;
}
outer();

// Batch 13 named-callback fixture (hand-written): named function
// expressions passed as callbacks are live by position — their names
// are visible only inside themselves, so they can never be referenced
// from outside. The web analyzer must not record them as definitions
// at all: the CLI's tree-sitter parser records function_declaration
// nodes only, never function_expression (src/parse-js.js). Before
// this fix, the web regex recorded every callback passed on its own
// line (`settle(\n function _resolve...`, axios
// lib/adapters/xhr.js) as a definition that nothing references, and
// graded it SAFE.
'use strict';

// A tiny callback runner, hand-written for this fixture (the axios
// settle / Promise.then shape, not copied code).
function settle(onResolve, onReject, value) {
  if (value && value.ok) onResolve(value);
  else onReject(new Error('bad value'));
}

function runJob(input) {
  settle(
    function _resolve(value) {
      return value;
    },
    function _reject(err) {
      throw err;
    },
    input,
  );
  return Promise.resolve(input).then(
    function onFulfilled(value) {
      return value;
    },
    function onRejected(reason) {
      throw reason;
    },
  );
}

// A named function expression as a forEach callback (the axios xhr.js
// setRequestHeader shape: utils.forEach(obj, function
// setRequestHeader(val, key) {...})).
function applyHeaders(headers, target) {
  Object.keys(headers).forEach(
    function setHeader(key) {
      target.set(key, headers[key]);
    },
  );
}

// An async named function expression passed to a helper (the axios
// stackTraceTest shape: assert.rejects(async function
// stackTraceTest() {...})).
function checkAsync(run) {
  return run(
    async function stackCheck() {
      return true;
    },
  );
}

// A named function expression after `=` on the previous line: the
// line sits at paren depth 0, so only the previous-line continuation
// rule keeps it an expression.
function lazyFn() {
  const f =
    function namedLazy() {
      return 1;
    };
  return f();
}

// Control: a real function DECLARATION that nothing calls is still
// found (SAFE). Same callback-ish shape, but a declaration, so the
// name is a definition that needs a reference.
function deadHandler(value) {
  return value;
}

// Control: a real declaration that IS called stays live.
function liveHandler(value) {
  return value;
}

function runAll() {
  runJob({ ok: true });
  applyHeaders({ a: '1' }, new Map());
  checkAsync((fn) => fn());
  lazyFn();
  return liveHandler(1);
}

module.exports = { runJob, applyHeaders, checkAsync, lazyFn, runAll };

// Function declarations hoist to the top of their enclosing function,
// so a helper declared textually after a `return` is still callable
// before it. SvelteKit uses exactly this shape: `get_data_type` in
// core/sync/write_types/index.js is called above and declared below
// the return, as are `apply_handle` in exports/hooks/sequence.js and
// `create_leaf_loader` / `create_layout_loader` in
// runtime/client/parse.js. None of those helpers is unreachable.
function build(value) {
  if (value) return format(value);
  return fallback();

  function format(v) {
    return 'got ' + v;
  }

  function fallback() {
    return format('default');
  }
}

// Same shape after a `throw`: the helper is hoisted, so the call inside
// the try block resolves even though the declaration sits below the
// terminating statement.
function runWithThrow() {
  try {
    return work();
  } catch (_) {
    return 'caught';
  }
  throw new Error('never reached');

  function work() {
    return 'done';
  }
}

// Async function declarations hoist the same way.
function makeAsync() {
  return load();

  async function load() {
    return 'async-value';
  }
}

// Generator function declarations hoist the same way.
function makeGen() {
  return gen();

  function* gen() {
    yield 'gen-value';
  }
}

module.exports = { build, runWithThrow, makeAsync, makeGen };

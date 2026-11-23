// Entry point: uses bare.js's top-level shared/escapes through the
// required namespace, so those top-level symbols are live — but the
// same-named locals inside bare.js must not inherit that credit as
// variables (the local shared stays SAFE); the local function escapes
// keeps its cross-file credit because a function local can escape.
const bare = require('./bare');

function main() {
  return bare.shared + bare.escapes();
}
main();

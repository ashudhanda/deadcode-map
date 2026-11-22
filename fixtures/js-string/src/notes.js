'use strict';

// Prose mentions of the dead helpers — words in sentences, not references.
// The dotted string below IS a real dynamic reference to `handler`.
const msg = 'please render the page';
const note = 'a named export is nice';
const route = 'handlers.handler';
const encoded = 'see %70age.';

function logNotes() {
  console.log(msg, note, route, encoded);
}

module.exports = { logNotes };

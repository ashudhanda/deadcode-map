'use strict';

// Entry point. `render` and `named` are dead helpers mentioned only in
// prose; `handler` is named by a dotted string; `wired` by config.json.
const { logNotes } = require('./notes');

function render() { return 1; }
function named() { return 2; }
function handler() { return 3; }
function wired() { return 4; }

function main() {
  logNotes();
  console.log('start');
}

main();

// Entry point: drives the callback shapes, so the live ones are
// reachable from here.
const callbacks = require('./callbacks');

callbacks.runAll();

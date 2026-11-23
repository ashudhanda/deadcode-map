// Batch 12 bare fixture (hand-written): the web analyzer's bare
// reference channel must match the CLI — a dead local named after a
// called method is found, a local read or called by its bare name is
// live, a method stays live through obj.method(), and a non-exported
// variable local gets no cross-file credit for a same-named top-level
// symbol used elsewhere.
class Worker {
  dead() { return 1; } // same-named method for the dead local below
  alive() { return 2; } // live method: called as worker.alive() below
  get slots() { return 3; } // live accessor: read as a property below
  idle() { return 4; } // dead method: REVIEW at most, never SAFE
}

const shared = 100; // top-level shared: read as bare.shared from other.js, live
function escapes() { return 200; } // top-level escapes: called as bare.escapes() from other.js, live

function outer() {
  const dead = 42; // (a) dead local: only worker.dead() shares the name
  function keptByCall() { return 5; } // (b) live local function: called bare below
  const keptByRead = 6; // (c) live local variable: read bare below
  const shared = 7; // (d) dead local variable: same name as the top-level shared used from other.js
  function escapes() { return 8; } // dead local function — but a function local CAN escape, so the cross-file call keeps it live
  const plainDead = 9; // control: dead local, no same-name anything
  const worker = new Worker();
  return worker.dead() + worker.alive() + worker.slots + keptByCall() + keptByRead;
}
outer();

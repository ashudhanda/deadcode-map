// Classic script: a constructor other classic scripts build with `new`.
// Loaded with the other scripts on the same page; its top-level
// constructor is a global the other scripts construct.
var MemoryStats = function () {
  return { domElement: null };
};

var DeadStats = function () {
  return { domElement: null };
};

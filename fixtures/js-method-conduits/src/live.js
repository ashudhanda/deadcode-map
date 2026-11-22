class Live {
  doLiveWork() { return liveHelper(); }
}

function liveHelper() { return 1; }

module.exports = { Live };

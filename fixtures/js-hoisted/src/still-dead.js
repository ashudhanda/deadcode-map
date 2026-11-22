// Control: a plain statement after `return` is genuinely unreachable
// and must still be flagged SAFE. Only function declarations hoist;
// an expression statement never runs.
function deadAfterReturn() {
  return 1;
  console.log('this line never runs');
}

module.exports = { deadAfterReturn };

const { leafFn } = require('./dead-leaf');

function helper() {
  return leafFn();
}

module.exports = { helper };

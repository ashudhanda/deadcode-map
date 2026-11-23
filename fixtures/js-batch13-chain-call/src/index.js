// Entry point: drives the live chain shapes.
const chain = require('./chain');

console.log(chain.getFillColor('US', 'light'));
console.log(chain.getTint(chain.colorOf('US'), 'dark'));

const { build, runWithThrow, makeAsync, makeGen } = require('./hoisted');
const { deadAfterReturn } = require('./still-dead');

console.log(build('hello'));
console.log(runWithThrow());
console.log(makeAsync());
console.log(makeGen().next().value);
console.log(deadAfterReturn());

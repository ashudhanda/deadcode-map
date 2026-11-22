const { Live } = require('./live');
const { usedFn } = require('./dead');

const live = new Live();
console.log(live.doLiveWork());
console.log(usedFn());

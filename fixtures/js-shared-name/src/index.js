const { Live } = require('./live');

// The class is constructed here; its method runs via framework
// dispatch, never via an in-repo call — so the method itself stays
// REVIEW, while the const it reads is live through it.
const live = new Live();
console.log(live);

// A module-level const and a method share the name `shared`
// (NestJS streaming.module.ts shape: `const missingFile` at line 61
// and the `missingFile()` route handler at line 694). The method runs
// via framework dispatch and reads the const, so the const is live —
// but the method itself is still only REVIEW, never invisible.
const shared = 'live-value';

class Live {
  shared() {
    return shared;
  }
}

module.exports = { Live };

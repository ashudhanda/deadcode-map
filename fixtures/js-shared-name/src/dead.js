// The same name shape, but the method never reads the const: the
// name collision alone must NOT rescue the const. The class is never
// constructed, imported, or referenced, so the const is dead too.
const orphan = 'dead-value';

class Dead {
  orphan() {
    return 'not the const';
  }
}

module.exports = {};

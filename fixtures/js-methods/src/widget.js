class Widget {
  constructor() { this.x = 1; }
  used() { return this.x; }
  neverCalled() { return 2; }
}

module.exports = { Widget };

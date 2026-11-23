import { deadLeafFn } from './dead-leaf.js';

export function deadMidFn() {
  deadLeafFn();
  // The string 'deadString' is the stem of deadString.js. This file
  // is the only file that mentions it, and this file is itself dead —
  // so deadString.js is REVIEW in pass 1 and SAFE once this file is
  // graded dead (pass 3), never kept alive by a dead mention.
  return 'deadString';
}

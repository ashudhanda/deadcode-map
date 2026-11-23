// Regression fixture: unused imports must report their real line,
// not line 1 (batch 13). The imports below sit past the first line
// on purpose, and the second import spans several lines.
import { unusedImport, usedHelper } from './helper';
const marker = 1;
const other = 2;
import {
  unusedMulti,
  alsoUnused,
  usedOther,
} from './other';
const unusedReq = require('./helper');
const alsoUsed = 3;

console.log(marker, other, alsoUsed, usedHelper(), usedOther());

// Imports of the workspace's own package names resolve to the
// packages' own source (vuejs-core shape: `from 'vue'`, `@vue/*`).
import { usedConst, usedFn } from '@scope/a';
import { usedUtil } from '@scope/a/src/util';

console.log(usedFn(), usedConst, usedUtil());

// Type tests: the declarations ARE the test — the type checker runs
// this file (the `test-dts-only` shape: `tsc -p tsconfig.test.json`),
// so nothing here is dead code even though nothing imports this file.
import { expectType } from './expect.js';
import type { Widget } from './lib.js';

export interface TestWidget extends Widget {
  label: string;
}

// Unused declarations in a type-test file are still test code: the
// file is the test, so they are KEEP, never SAFE.
export interface UnusedTestType {
  x: number;
}

const unusedTestConst = 1;

declare const widget: TestWidget;

expectType<string>(widget.name);
expectType<number>(widget.size);

// NestJS end-to-end spec: run by the sample's own
// vitest.config.e2e.mts (`include: ['e2e/**/*.e2e-spec.ts']`,
// `test:e2e` script), never imported by app code. It is a test entry
// point, like `*.spec.ts` / `*.test.ts` — KEEP, never SAFE.
import { Test } from '@nestjs/testing';
import { CatsModule } from '../../src/cats/cats.module.js';
import { unusedHelper } from '../../src/cats/unused-helper.js';

describe('Cats', () => {
  it('creates the module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CatsModule] }).compile();
    expect(moduleRef).toBeDefined();
  });
});

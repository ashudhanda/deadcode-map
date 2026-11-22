// Same shape as the `.ts` spec, in plain JavaScript: `*.e2e-spec.js`
// is a test entry point too.
const { Test } = require('@nestjs/testing');
const { CatsModule } = require('../../src/cats/cats.module.js');
const { unusedHelper } = require('../../src/cats/unused-helper.js');

describe('Cats', () => {
  it('creates the module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CatsModule] }).compile();
    expect(moduleRef).toBeDefined();
  });
});

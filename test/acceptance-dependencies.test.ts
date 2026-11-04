/**
 * S6b: what a frozen acceptance check loads is either frozen with it, shown as
 * the code under test, or refused because it cannot be protected.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { isTestSupport, moduleLoads, planAcceptanceDependencies, type DependencyReader } from '../src/acceptanceDependencies.js';

function reader(files: Record<string, string>): DependencyReader {
  return {
    async stat(rel: string) {
      if (rel in files) {
        return { kind: 'file' as const, size: (files[rel] as string).length };
      }
      return Object.keys(files).some((file) => file.startsWith(`${rel}/`)) ? { kind: 'dir' as const } : { kind: 'missing' as const };
    },
    async readText(rel: string) {
      if (!(rel in files)) {
        throw new Error('missing');
      }
      return files[rel] as string;
    },
  };
}

test('helpers the check loads are frozen with it; the code under test stays writable and is reported', async () => {
  const files = {
    'acceptance/accept.test.js': "const add = require('../lib/sum.js');\nconst cases = require('./cases.js');\nconst t = require('node:test');\nconst x = require('assert');\n",
    'acceptance/cases.js': "module.exports = require('./data/cases.json');\n",
    'acceptance/data/cases.json': '[[2,3,5]]',
    'lib/sum.js': "module.exports = require('./impl');\n",
    'lib/impl.js': 'module.exports = (a, b) => a + b;\n',
  };
  const plan = await planAcceptanceDependencies(reader(files), ['acceptance/accept.test.js']);
  assert.deepEqual(plan, { ok: true, freeze: ['acceptance/cases.js', 'acceptance/data/cases.json'], subjects: ['lib/sum.js'], packages: [] });
});

test('support outside the acceptance folder is recognised by its path; ESM imports and re-exports count', async () => {
  const files = {
    'acceptance/accept.test.mjs': "import add from '../lib/sum.mjs';\nimport { cases } from '../test/helpers/cases.mjs';\nimport '../fixtures/setup.mjs';\nexport { x } from '../spec-data.json';\n",
    'lib/sum.mjs': 'export default (a, b) => a + b;\n',
    'test/helpers/cases.mjs': "export const cases = await import('./more.mjs');\n",
    'test/helpers/more.mjs': 'export default [];\n',
    'fixtures/setup.mjs': '',
    'spec-data.json': '{}',
  };
  const plan = await planAcceptanceDependencies(reader(files), ['acceptance/accept.test.mjs']);
  assert.deepEqual(plan, {
    ok: true,
    freeze: ['fixtures/setup.mjs', 'spec-data.json', 'test/helpers/cases.mjs', 'test/helpers/more.mjs'],
    subjects: ['lib/sum.mjs'],
    packages: [],
  });
});

test('a load RAME cannot determine refuses the authorization and names it', async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ 'acceptance/a.test.js': "const name = './cases';\nrequire(name);\n" }, /loads a module whose path RAME cannot determine \(require\(name\)/],
    [{ 'acceptance/a.test.js': 'require(`./cases-${process.env.X}`);\n' }, /cannot determine/],
    [{ 'acceptance/a.test.js': 'const m = await import(path);\n' }, /cannot determine \(import\(path\)/],
    [{ 'acceptance/a.test.js': "const r = require('node:module').createRequire(__filename);\n" }, /cannot determine \(createRequire/],
    [{ 'acceptance/a.test.js': "require('#cases');\n" }, /through a package\.json import alias/],
    [{ 'acceptance/a.test.js': "require('/etc/cases.js');\n" }, /loads an absolute path/],
    [{ 'acceptance/a.test.js': "require('./missing');\n" }, /loads \.\/missing, which does not exist yet; a test file the agent could create cannot be protected/],
    [{ 'acceptance/a.test.js': "require('../../outside.js');\n" }, /outside the project or protected/],
    [{ 'acceptance/a.test.js': "require('./cases');\n", 'acceptance/cases.js': '' }, /loads \.\/cases without its exact file name; the agent could add a file Node loads first\. Write '\.\/cases\.js'/],
    [{ 'acceptance/a.test.js': "require('./data');\n", 'acceptance/data/index.js': '' }, /without its exact file name.*Write '\.\/data\/index\.js'/],
    [{ 'acceptance/a.test.js': "require('node:fs').readFileSync('acceptance/expected.json');\n" }, /reads acceptance\/expected\.json, test data that does not exist as a file yet/],
    [{ 'acceptance/a.test.js': "require('../.env.js');\n" }, /outside the project or protected/],
    [{ 'acceptance/a.test.js': "require('shop/lib/sum');\n" }, /by its own package name/],
  ];
  for (const [files, error] of cases) {
    const plan = await planAcceptanceDependencies(reader(files), ['acceptance/a.test.js'], 'shop');
    assert.equal(plan.ok, false, JSON.stringify(files));
    assert.match((plan as { error: string }).error, error);
  }
});

test('test data read through a literal path is frozen; product output read the same way stays writable', async () => {
  const files = {
    'acceptance/a.test.js': "const fs = require('node:fs');\nconst path = require('node:path');\nconst expected = fs.readFileSync(path.join(__dirname, 'expected.txt'), 'utf8');\nconst golden = fs.readFileSync('test/golden/out.json');\nconst actual = fs.readFileSync('a.txt', 'utf8');\n",
    'acceptance/expected.txt': 'final',
    'test/golden/out.json': '{}',
  };
  const plan = await planAcceptanceDependencies(reader(files), ['acceptance/a.test.js']);
  assert.deepEqual(plan, { ok: true, freeze: ['acceptance/expected.txt', 'test/golden/out.json'], subjects: [], packages: [] });
});

test('missing code under test is allowed and named; it is what the agent is asked to write', async () => {
  const plan = await planAcceptanceDependencies(reader({ 'acceptance/a.test.js': "require('../lib/sum.js');\n" }), ['acceptance/a.test.js']);
  assert.deepEqual(plan, { ok: true, freeze: [], subjects: ['lib/sum.js (not created yet)'], packages: [] });
});

test('builtins and installed packages are not files of the project; a check at the project root does not freeze everything', async () => {
  const files = {
    'accept.test.js': "require('node:assert');\nrequire('fs/promises');\nrequire('@scope/pkg/sub');\nrequire('lodash');\nrequire('./lib/sum');\n",
    'lib/sum.js': '',
  };
  const plan = await planAcceptanceDependencies(reader(files), ['accept.test.js'], 'shop');
  assert.deepEqual(plan, { ok: true, freeze: [], subjects: ['lib/sum.js'], packages: ['@scope/pkg', 'lodash'] });
});

test('moduleLoads finds literal loads and flags computed ones; isTestSupport is path-based', () => {
  assert.deepEqual(moduleLoads("require('./a'); import b from \"../b\"; import('./c');"), [
    { specifier: './a', dynamic: false },
    { specifier: './c', dynamic: false },
    { specifier: '../b', dynamic: false },
  ]);
  assert.ok(moduleLoads('require(x)').some((load) => load.dynamic));
  assert.equal(isTestSupport('src/util.test.ts', []), true);
  assert.equal(isTestSupport('src/__fixtures__/a.js', []), true);
  assert.equal(isTestSupport('lib/sum.js', ['acceptance']), false);
  assert.equal(isTestSupport('lib/sum.js', ['']), false, 'a check at the root does not make the whole project support');
});

test('AUD-07: a computed load mentioned only in a comment no longer refuses protection; literal loads are never lost', () => {
  const commented = "// e.g. require(name) would be computed\n/* import(x) */\nconst add = require('../lib/sum.js');\n";
  assert.equal(moduleLoads(commented).some((load) => load.dynamic), false, 'comments are not code');
  assert.deepEqual(moduleLoads(commented).filter((load) => !load.dynamic), [{ specifier: '../lib/sum.js', dynamic: false }]);
  assert.ok(moduleLoads("const u = 'http://x'; require(name);").some((load) => load.dynamic), 'a // inside a string is not a comment');
  // A regex literal with a quote can confuse the scanner: the literal load is still found in the original text.
  assert.ok(moduleLoads("const r = /'/; const h = require('./helper.js');\n").some((load) => !load.dynamic && load.specifier === './helper.js'));
  assert.ok(moduleLoads("// require('./documented.js')\n").some((load) => !load.dynamic && load.specifier === './documented.js'), 'a literal load in a comment is still followed (conservative)');
});

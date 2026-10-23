import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRepository, isPublicPath, publicationIssues } from '../scripts/check-public-source.mjs';

test('public source excludes operational files even when force-added', () => {
  for (const path of ['src/node.mjs', 'test/public-source.test.mjs', 'docs/OPERATORS.md', '.github/workflows/ci.yml']) {
    assert.equal(isPublicPath(path), true, path);
  }
  for (const path of ['wallet.json', 'genesis.json', 'alice.json', '.env', '.local/key.json', 'data/node.sqlite', 'dist/app.dmg']) {
    assert.equal(isPublicPath(path), false, path);
  }
  const root = mkdtempSync(join(tmpdir(), 'frobenius-publication-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'wallet.json\n');
    writeFileSync(join(root, 'wallet.json'), JSON.stringify({ seed: 'ab'.repeat(32) }));
    assert.equal(checkRepository(root).findings.length, 0);
    execFileSync('git', ['add', '--force', 'wallet.json'], { cwd: root });
    const findings = checkRepository(root).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].path, 'wallet.json');
    assert.equal(findings[0].issues.length, 2);
    assert.ok(!JSON.stringify(findings).includes('ab'.repeat(32)), 'findings must not reveal the seed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only the two deterministic vector seeds are exempt from private-value detection', () => {
  for (const byte of ['01', '02']) {
    const content = JSON.stringify({ seed: byte.repeat(32) });
    assert.deepEqual(publicationIssues('test/vectors.json', content), []);
    assert.ok(publicationIssues('docs/EXAMPLE.md', content).length > 0);
  }
  assert.ok(publicationIssues('test/vectors.json', JSON.stringify({ seed: '03'.repeat(32) })).length > 0);
  assert.ok(publicationIssues('src/config.mjs', `const FROBENIUS_VALIDATOR_SEED = '${'ab'.repeat(32)}';`).length > 0);
  assert.ok(publicationIssues('README.md', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).length > 0);
});

test('allowlisted symlinks cannot introduce files from outside the public source', () => {
  const root = mkdtempSync(join(tmpdir(), 'frobenius-publication-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    symlinkSync('/tmp/not-a-public-source-file', join(root, 'README.md'));
    const { findings } = checkRepository(root);
    assert.equal(findings.length, 1);
    assert.match(findings[0].issues[0], /not symlinks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

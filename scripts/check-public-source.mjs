#!/usr/bin/env node
// Targeted publication guard. Does not inspect ignored untracked files or history.
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_FILES = new Set([
  '.gitignore', '.dockerignore', 'Dockerfile', 'README.md', 'LICENSE',
  'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'package.json', 'package-lock.json',
]);
const PUBLIC_PATHS = [
  /^(src|bin|scripts|test)\/[A-Za-z0-9_/-]+(?:\.test)?\.mjs$/,
  /^docs\/[A-Za-z0-9_/-]+\.md$/,
  /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/,
];
const VECTOR_SEEDS = new Set(['01'.repeat(32), '02'.repeat(32)]);

export function isPublicPath(path) {
  return ROOT_FILES.has(path) || path === 'test/vectors.json' || PUBLIC_PATHS.some(pattern => pattern.test(path));
}

export function publicationIssues(path, content) {
  const issues = [];
  if (!isPublicPath(path)) issues.push('path is outside the public-source allowlist');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(content)) {
    issues.push('contains a private-key PEM header');
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(content)) {
    issues.push('contains a credential-shaped token');
  }
  const literals = /["']?(seed|privateKey|secretKey|mnemonic|FROBENIUS_VALIDATOR_SEED)["']?\s*[:=]\s*["']([A-Za-z0-9 +/=]{32,})["']/g;
  for (const match of content.matchAll(literals)) {
    if (path === 'test/vectors.json' && match[1] === 'seed' && VECTOR_SEEDS.has(match[2])) continue;
    issues.push('contains a literal private-key or recovery value');
    break;
  }
  return issues;
}

export function checkRepository(root) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const findings = [];
  for (const path of [...new Set(paths)].sort()) {
    const full = resolve(root, path);
    let stat;
    try { stat = lstatSync(full); } catch {
      findings.push({ path, issues: ['tracked file is missing; review and commit the deletion before publishing'] });
      continue;
    }
    if (!stat.isFile()) {
      findings.push({ path, issues: ['public-source files must be regular files, not symlinks or directories'] });
      continue;
    }
    const issues = publicationIssues(path, readFileSync(full, 'utf8'));
    if (issues.length) findings.push({ path, issues });
  }
  return { count: new Set(paths).size, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = checkRepository(root);
  for (const { path, issues } of result.findings) {
    // Print paths/reasons only, never the credential-like value.
    console.error(`${JSON.stringify(path)}: ${issues.join('; ')}`);
  }
  if (result.findings.length) process.exitCode = 1;
  else console.log(`Publication check passed for ${result.count} public source files.`);
}

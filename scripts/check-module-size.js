'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAX_APPROX_TOKENS = 16_000;
const CHARS_PER_TOKEN = 4;

// Temporary migration caps. These files must only shrink until their
// responsibilities have moved into bounded modules, then the exceptions go.
const LEGACY_CAPS = new Map([
  ['media/main.js', 102_543],
  ['media/i18n.js', 65_200],
]);

function sourceFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(rel));
    } else if (/\.(?:ts|js)$/.test(entry.name)) {
      found.push(rel.replaceAll(path.sep, '/'));
    }
  }
  return found;
}

const failures = [];
for (const rel of [...sourceFiles('src'), ...sourceFiles('media')]) {
  const size = fs.readFileSync(path.join(ROOT, rel), 'utf8').length;
  const legacyCap = LEGACY_CAPS.get(rel);
  if (legacyCap !== undefined) {
    if (size > legacyCap) {
      failures.push(`${rel}: ${size} characters exceeds its frozen legacy cap ${legacyCap}`);
    }
    continue;
  }
  const approxTokens = Math.ceil(size / CHARS_PER_TOKEN);
  if (approxTokens > MAX_APPROX_TOKENS) {
    failures.push(`${rel}: approximately ${approxTokens} tokens exceeds ${MAX_APPROX_TOKENS}`);
  }
}

if (failures.length > 0) {
  console.error('Source-file context policy failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Source-file context policy passed (each new file max approximately ${MAX_APPROX_TOKENS} tokens; legacy files may only shrink).`);
}

// Writes out/build-info.json: the public version, the build revision, and
// the channel. Read-only git queries; without git the revision is "unknown".
// "release" only when the working tree is clean and HEAD is the commit of
// the tag v<version>; every other build is a "candidate".
'use strict';
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Digest of what ships: the compiled sources and the media files.
function sourceDigest() {
  const hash = createHash('sha256');
  const walk = (dir) => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) {
        walk(file);
      } else if (!name.endsWith('.map')) {
        hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
      }
    }
  };
  walk(path.join(root, 'out', 'src'));
  walk(path.join(root, 'media'));
  return hash.digest('hex').slice(0, 12);
}

const head = git(['rev-parse', '--short=7', 'HEAD']);
const dirty = head !== null && (git(['status', '--porcelain', '--untracked-files=normal']) ?? 'unknown').length > 0;
const tagged = head !== null && git(['rev-parse', '--short=7', `v${version}^{commit}`]) === head;
const digest = sourceDigest();
const info = {
  version,
  revision: head === null ? `src.${digest}` : `${head}${dirty ? '-dirty' : ''}.src.${digest}`,
  channel: head !== null && !dirty && tagged ? 'release' : 'candidate',
};
fs.mkdirSync(path.join(root, 'out'), { recursive: true });
fs.writeFileSync(path.join(root, 'out', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

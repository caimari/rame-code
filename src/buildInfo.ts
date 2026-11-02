/**
 * Version, build revision, and channel of this extension, written to
 * out/build-info.json by scripts/build-info.js at compile time. Missing or
 * malformed data never claims more than it knows: the version falls back to
 * package.json, the revision to "unknown", and the channel to "candidate".
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface BuildInfo {
  version: string;
  revision: string;
  channel: 'candidate' | 'release';
}

const FIELD = /^[0-9A-Za-z.+_-]{1,64}$/;

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readBuildInfo(extensionRoot: string): BuildInfo {
  const manifest = readJson(path.join(extensionRoot, 'package.json'));
  const info = readJson(path.join(extensionRoot, 'out', 'build-info.json'));
  const field = (value: unknown): string | null => (typeof value === 'string' && FIELD.test(value) ? value : null);
  const version = field(manifest?.version) ?? field(info?.version) ?? 'unknown';
  return {
    version,
    revision: field(info?.revision) ?? 'unknown',
    // A release is only what the build script verified as one, for this version.
    channel: info?.channel === 'release' && info.version === version ? 'release' : 'candidate',
  };
}

export interface PublicEvidenceEnvironment {
  readonly homeDir: string;
  readonly tempDir: string;
  readonly repositoryRoot: string;
  readonly username: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Refuse public evidence that contains an absolute local path, a structured
 * account-name disclosure, or common key material. Ordinary prose may contain
 * the same word as the OS account (GitHub Actions uses `runner`), so a bare
 * substring is deliberately not treated as identity evidence.
 */
export function publicEvidenceHasPrivateMaterial(text: string, environment: PublicEvidenceEnvironment): boolean {
  const paths = [environment.homeDir, environment.tempDir, environment.repositoryRoot]
    .filter((value) => value.length > 2);
  if (paths.some((value) => text.includes(value))) {
    return true;
  }
  if (/\/(?:home|Users)\/|[A-Za-z]:\\\\|sk-[A-Za-z0-9]{16,}|-----BEGIN/.test(text)) {
    return true;
  }
  const username = environment.username.trim();
  if (username.length <= 2) {
    return false;
  }
  const escaped = escapeRegExp(username);
  const pathSegment = new RegExp(`(?:^|[\\\\/])${escaped}(?:[\\\\/]|$)`, 'i');
  const namedField = new RegExp(`(?:user(?:name)?|account|owner)\\s*[:=]\\s*["']?${escaped}(?=["'\\s,}]|$)`, 'i');
  return pathSegment.test(text) || namedField.test(text);
}

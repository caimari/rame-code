/** Isolation for allowlisted tests, including the explicit verification mode chosen by the host. */
import * as path from 'node:path';

import type { ProviderHost } from './providerTypes.js';
import { ISOLATION_WORDS, isolatedInvocation, isolationRefusal, isolationSupport, isolationUnavailableText, protectedVerificationRefusal, protectedVerifierInvocation, type ProtectedInvocationAccess, type VerificationMode } from './shellIsolation.js';

export async function isolateTest(host: ProviderHost, executable: string, argv: string[], root: string, env: Record<string, string> | undefined, protectedAccess?: ProtectedInvocationAccess, verificationMode?: VerificationMode): Promise<{ ok: true; executable: string; argv: string[]; label: string } | { ok: false; error: string }> {
  if (protectedAccess !== undefined) {
    if (verificationMode?.kind === 'unprotected') {
      return { ok: true, executable, argv, label: `verification without isolation: ${verificationMode.reason}` };
    }
    const support = await isolationSupport();
    const refusal = protectedVerificationRefusal(support);
    if (refusal !== null) return { ok: false, error: `Not run: protected verification requires read confinement and a closed network, and ${refusal}.` };
    const argumentFiles = argv.filter((part) => path.isAbsolute(part));
    // Keep the Node/npm toolchain that is running RAME available inside the
    // verifier.  Without this exact runtime tree, execvp can skip an NVM npm
    // denied by Landlock and silently fall through to /usr/bin/npm, causing a
    // "Node 20" suite to verify projects with an unrelated system Node.
    const activeNodeRuntime = path.dirname(path.dirname(process.execPath));
    return {
      ok: true,
      ...protectedVerifierInvocation(executable, argv, {
        ...protectedAccess,
        readFiles: [...protectedAccess.readFiles, ...argumentFiles],
        readTrees: [...(protectedAccess.readTrees ?? []), activeNodeRuntime],
      }),
      label: 'protected verifier: exact project reads, no ambient files, no TCP',
    };
  }
  const level = host.settings.shell?.isolation ?? 'project';
  const refusal = isolationRefusal(level, level === 'total' ? { ok: true, abi: 0 } : await isolationSupport());
  if (refusal !== null) return { ok: false, error: isolationUnavailableText('tests', level, refusal) };
  const writes = Object.entries(env ?? {}).filter(([key, value]) => (key === 'RAME_TRACE_FILE' || key === 'RAME_RESULTS_FILE') && path.isAbsolute(value)).map(([, value]) => path.dirname(value));
  return { ok: true, ...isolatedInvocation(level, executable, argv, root, undefined, undefined, writes), label: ISOLATION_WORDS[level] };
}

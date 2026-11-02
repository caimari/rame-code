import type { AgentFs } from '../agentHost.js';

/** Project-specific discovery kept outside the extension-host coordinator. */
export interface ProjectAdapter {
  readonly id: string;
  readonly acceptanceEnvironmentFiles: readonly string[];
  listAcceptanceCandidates(fs: AgentFs): Promise<string[]>;
}

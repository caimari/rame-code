import type { AgentFs } from '../agentHost.js';
import type { AllowedTestCommand } from '../agentCommands.js';

export interface ProjectTestContext {
  allowlist: AllowedTestCommand[];
  packageJsonRaw: string;
  scripts: Record<string, string>;
}

/** Project-specific discovery kept outside the extension-host coordinator. */
export interface ProjectAdapter {
  readonly id: string;
  readonly acceptanceEnvironmentFiles: readonly string[];
  listAcceptanceCandidates(fs: AgentFs): Promise<string[]>;
  testContext(fs: AgentFs): Promise<ProjectTestContext>;
}

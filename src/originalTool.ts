/**
 * `read_original` (I-16): during a Mission with a differential reference,
 * the agent may read the original files as they were when the Mission was
 * authorized, from RAME's read-only copy (originalCopy.ts). Read-only, no
 * card; offered only in that Mission's runs.
 */

import type { AgentToolDefinition } from './agentTools.js';
import { readVisibleOriginal, type VisibleOriginal } from './originalCopy.js';
import type { ProviderHost } from './providerTypes.js';

/** The visible copies of the running Mission, if any. */
export function visibleOriginals(host: Pick<ProviderHost, 'missionAuto' | 'missions'>): VisibleOriginal[] {
  const auto = host.missionAuto;
  if (auto === null) {
    return [];
  }
  const references = host.missions.get(auto.missionId)?.grant?.acceptance?.references ?? [];
  return references.flatMap((reference) => (reference.visible ? [reference.visible] : []));
}

export function originalToolDefinitions(host: Pick<ProviderHost, 'missionAuto' | 'missions'>): AgentToolDefinition[] {
  const copies = visibleOriginals(host);
  if (copies.length === 0) {
    return [];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'read_original',
        description:
          'Read the original code as it was when this Mission was authorized (read-only; it is not the file you edit). The host compares your code with this original at every check, so your results must match it for every input. Without "path" it lists the original files.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Project path of an original file, as listed.' } }, required: [], additionalProperties: false },
      },
    },
  ];
}

export function executeReadOriginal(host: Pick<ProviderHost, 'missionAuto' | 'missions'>, args: Record<string, unknown>): Promise<string> {
  return readVisibleOriginal(visibleOriginals(host), typeof args.path === 'string' ? args.path : '');
}

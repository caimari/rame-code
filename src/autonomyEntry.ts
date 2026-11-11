/**
 * Entry of the Autonomy & Permissions messages from the main view: resolves
 * the open workspace the way Settings does and hands the message to the
 * host module. Kept apart so `autonomyHost.ts` does not depend on the
 * memory controller (which reports the workspace to it).
 */

import { handleAutonomyMessage } from './autonomyHost.js';
import { AUTONOMY_MESSAGE_TYPES, type AutonomyMessage } from './autonomyView.js';
import { memoryScopeForUi } from './memoryController.js';
import type { ProviderHost } from './providerTypes.js';

export function isAutonomyMessage(message: { type: string }): message is AutonomyMessage {
  return AUTONOMY_MESSAGE_TYPES.includes(message.type);
}

export function onAutonomyMessage(host: ProviderHost, message: AutonomyMessage): Promise<void> {
  return handleAutonomyMessage(host, message, () => memoryScopeForUi(host));
}

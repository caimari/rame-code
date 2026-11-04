/**
 * The connection state the view shows when nothing is running, for the
 * selected runtime only. "verified" needs a valid answer observed in this
 * session from that runtime (`cloudConfirmed` / `localConfirmed`); a stored
 * key or a saved endpoint alone is only "ready".
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Who sets the confirmations:
 *   - Meta (`cloudConfirmed`): set only after a complete, valid answer
 *     (Chat, Mission plan, an Agent or Delegated step, a validated Advisory
 *     or acceptance-review answer, or a live model catalog); never by
 *     accounting usage, a malformed reply, a cancelled or failed request.
 *     Cleared when the key is saved, replaced or removed, and on an
 *     authentication failure.
 *   - local (`localConfirmed`): the endpoint that last answered.
 */

import type { ProviderHost } from './providerTypes.js';

export type IdleConnection = 'working' | 'missing-key' | 'ready' | 'verified';

export function idleConnection(state: {
  running: boolean;
  hasKey: boolean;
  provider: 'cloud' | 'local';
  cloudConfirmed: boolean;
  localConfirmed: string | null;
  localEndpoint: string | null;
}): IdleConnection {
  if (state.running) {
    return 'working';
  }
  if (state.provider === 'cloud') {
    return !state.hasKey ? 'missing-key' : state.cloudConfirmed ? 'verified' : 'ready';
  }
  if (state.localEndpoint === null) {
    return state.hasKey ? 'ready' : 'missing-key';
  }
  return state.localConfirmed === state.localEndpoint ? 'verified' : 'ready';
}

/** The idle state for a host, from its live fields. */
export function idleConnectionOf(host: ProviderHost): IdleConnection {
  return idleConnection({ running: host.running, hasKey: host.hasKey, provider: host.settings.provider, cloudConfirmed: host.cloudConfirmed, localConfirmed: host.localConfirmed, localEndpoint: host.localEndpoint() });
}

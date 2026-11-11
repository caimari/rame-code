/**
 * The last model-server scan of each window, the view built from it, and
 * the tool-capability refusal for Agent runs. No HTTP and no controller
 * imports here, so view builders can use it without import cycles.
 */

import { modelFitness, type LocalServerScan } from './localServers.js';
import type { LocalSourceView } from './localSourceView.js';
import type { ProviderHost } from './providerTypes.js';
import { DEFAULT_WEB, EMPTY_EXTERNAL_LOCAL } from './settingsStore.js';
import { advisorOptions } from './advisorModels.js';
import { advisorFor, catalogIds, mainModelOf } from './advisorHost.js';
import { isolationRefusal, isolationSupport, settledIsolationSupport } from './shellIsolation.js';

const probing = new WeakSet<object>();

/** The terminal's isolation level and whether it can be applied here (the check runs once, then the view updates). */
function shellView(host: ProviderHost): LocalSourceView['shell'] {
  const isolation = host.settings.shell?.isolation ?? 'project';
  const support = settledIsolationSupport();
  if (support === null && !probing.has(host)) {
    probing.add(host);
    void isolationSupport().then(() => host.postState()).catch(() => undefined);
  }
  return { enabled: host.settings.shell?.enabled === true, isolation, problem: support === null ? null : (isolationRefusal(isolation === 'total' ? 'project' : isolation, support) ?? '') };
}

function advisorView(host: ProviderHost): LocalSourceView['advisor'] {
  if (typeof host.generationModel !== 'function' || !Array.isArray(host.cloudCatalog)) {
    // A partial host (unit tests of other views): nothing to choose from.
    return { selected: host.settings?.advisorModel ?? '', main: '', mainProvider: 'local', options: [], problem: 'the main model is not known yet' };
  }
  const main = mainModelOf(host);
  const now = advisorFor(host, main);
  return {
    selected: host.settings.advisorModel ?? '',
    main: main.model,
    mainProvider: main.provider,
    options: advisorOptions(main, catalogIds(host)),
    problem: now.ok ? '' : now.reason,
  };
}

const scans = new WeakMap<object, { scan: LocalServerScan | null; error: string }>();

export function recordScan(host: ProviderHost, result: { scan: LocalServerScan | null; error: string }): void {
  scans.set(host, result);
}

export function lastScan(host: ProviderHost): LocalServerScan | null {
  return scans.get(host)?.scan ?? null;
}

/** The view of external servers and web access. */
export function localSourceView(host: ProviderHost): LocalSourceView {
  const stored = scans.get(host) ?? { scan: null, error: '' };
  const choice = host.settings.externalLocal ?? EMPTY_EXTERNAL_LOCAL;
  return {
    endpoint: host.settings.externalLocalEndpoint,
    model: choice.model,
    kind: choice.kind,
    lan: choice.lan,
    scan:
      stored.scan === null
        ? null
        : { ...stored.scan, models: stored.scan.models.map((model) => ({ ...model, ...modelFitness(model, stored.scan!.kind) })) },
    scanError: stored.error,
    web: { ...(host.settings.web ?? DEFAULT_WEB) },
    shell: shellView(host),
    advisor: advisorView(host),
  };
}

/**
 * Before an Agent or Mission run on an external server: a model the server
 * says cannot call tools is refused with a clear reason (Chat still works).
 */
export function externalToolsRefusal(host: ProviderHost): string | null {
  const endpoint = host.localEndpoint();
  const choice = host.settings.externalLocal;
  if (endpoint === null || endpoint !== host.settings.externalLocalEndpoint.trim() || choice.tools !== false) {
    return null;
  }
  return `The model ${choice.model || 'on the external server'} does not support tool calls, so it cannot run Agent or Mission. Use Chat only, or choose a model with tool use under Models.`;
}

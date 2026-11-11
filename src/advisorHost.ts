/**
 * The advisor model on the host side: which model a consultation may go to
 * for the main model that is working now (advisorModels.ts).
 *
 * Every consultation path asks here (Agent's advice, a blocked Mission's,
 * the Mission's automatic consultations and its acceptance review), so none
 * of them can send to the main model itself or to a model Meta does not
 * document as more capable. Permissions, budgets and data controls stay
 * where they were: this only says *which* model, never *whether*.
 */

import { advisorRefusal, type MainModel } from './advisorModels.js';
import type { ProviderHost } from './providerTypes.js';
import type { ProviderId } from './settingsStore.js';

/** The model doing the work for `provider` (the selected one when omitted). */
export function mainModelOf(host: ProviderHost, provider: ProviderId = host.settings.provider): MainModel {
  return { provider, model: host.generationModel(provider) };
}

/** A Mission's main model, as its authorization bound it (the selected one before it was authorized). */
export function missionMain(host: ProviderHost, missionId: string): MainModel {
  const grant = host.missions.get(missionId)?.grant ?? null;
  return grant !== null ? { provider: grant.provider, model: grant.model } : mainModelOf(host);
}

/** The Meta model ids RAME knows are offered now (live catalog, or the fallback one). */
export function catalogIds(host: ProviderHost): string[] {
  return host.cloudCatalog.map((entry) => entry.id);
}

/** The advisor for this main model, or why there is none. */
export function advisorFor(host: ProviderHost, main: MainModel = mainModelOf(host)): { ok: true; model: string } | { ok: false; reason: string } {
  const advisor = host.settings.advisorModel ?? '';
  const refusal = advisorRefusal(main, advisor, catalogIds(host));
  return refusal === null ? { ok: true, model: advisor.trim() } : { ok: false, reason: refusal };
}

/**
 * The advisor model a Meta pre-authorization covers now ('' = none). A
 * partial host without a catalog (unit tests of the policy alone) keeps
 * the selected cloud model, as before advisors existed.
 */
export function advisorModelNow(host: ProviderHost): string {
  if (typeof host.generationModel !== 'function' || !Array.isArray(host.cloudCatalog) || host.settings === undefined) {
    return typeof host.selectedCloudModel === 'function' ? host.selectedCloudModel() : '';
  }
  const advisor = advisorFor(host);
  return advisor.ok ? advisor.model : '';
}

/** A short name for the main model in statuses ("Glimmer", or the model id). */
export function mainModelName(main: MainModel): string {
  return main.provider === 'local' ? `the local model ${main.model}` : `Meta ${main.model}`;
}

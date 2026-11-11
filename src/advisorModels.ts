/**
 * The advisor model: the model the main model may consult when it is stuck.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 *
 * Two roles, chosen apart:
 *   - the main model (Glimmer or another local model, or a Meta Model API
 *     model) does the work: it calls RAME's tools and directs the Mission;
 *   - the advisor, a Meta Model API model, only answers a consultation in
 *     text. It never gets tools and never takes over.
 *
 * A model advises only when Meta's documentation describes it as more
 * capable than the main model. RAME never ranks by name or by "it is in the
 * cloud", never consults the main model itself as if it were an escalation,
 * and never invents a model: an id the catalog does not list, or whose
 * capability Meta does not document, is not an advisor.
 */

import { isCompatibleModelId, isContributorModelId } from './metaCatalog.js';

/** Where the capability facts below come from. */
export const ADVISOR_FACTS_SOURCE = 'Meta Model API documentation (dev.meta.ai/docs/models, muse-spark, muse-wonder), read on 2026-11-08';

/**
 * Capability rank documented by Meta for each Model API chat model (higher is
 * more capable). Equal ranks are not ordered: Meta does not rank Spark 1.3,
 * 1.2 and 1.1 against each other, so none of them advises another.
 */
export const DOCUMENTED_CAPABILITY: Readonly<Record<string, { rank: number; note: string }>> = {
  'muse-wonder-1.0': { rank: 3, note: "Meta's most capable model (preview)" },
  'muse-spark-1.3': { rank: 2, note: 'Spark, tuned for agentic work; recommended by Meta' },
  'muse-spark-1.2': { rank: 2, note: 'Spark, previous version' },
  'muse-spark-1.1': { rank: 2, note: 'Spark, original version' },
};

/**
 * A model running on this computer or a server of the user's (Glimmer, which
 * Meta distills from Spark, or any other local model). Every documented Meta
 * API model counts as more capable than it.
 */
export const LOCAL_RANK = 1;

export interface MainModel {
  provider: 'local' | 'cloud';
  model: string;
}

export interface AdvisorOption {
  id: string;
  /** Whether it may advise this main model. */
  eligible: boolean;
  /** Why not, when it may not; what Meta says about it, when it may. */
  reason: string;
}

function rankOf(main: MainModel): number | null {
  return main.provider === 'local' ? LOCAL_RANK : (DOCUMENTED_CAPABILITY[main.model]?.rank ?? null);
}

/**
 * Why `advisor` cannot advise `main` (null when it can). `catalog` is the
 * list of Meta models RAME knows are offered (the live catalog, or the
 * fallback one before a refresh).
 */
export function advisorRefusal(main: MainModel, advisor: string, catalog: readonly string[]): string | null {
  const id: string = advisor.trim();
  if (id.length === 0) {
    return 'no advisor model is chosen in Settings → Security → Escalation';
  }
  if (!isCompatibleModelId(advisor.trim())) {
    return `${id.slice(0, 80)} is not a Meta chat model`;
  }
  if (isContributorModelId(id)) {
    return `${id} is a Contributor variant (Meta may use the data), never an advisor`;
  }
  if (!catalog.includes(id)) {
    return `${id} is not in the Meta API catalog RAME loaded`;
  }
  if (main.provider === 'cloud' && main.model === id) {
    return `${id} is the main model itself: consulting it is not an escalation`;
  }
  const documented = DOCUMENTED_CAPABILITY[id];
  if (documented === undefined) {
    return `Meta's documentation, as RAME knows it, does not describe what ${id} can do`;
  }
  const mainRank = rankOf(main);
  if (mainRank === null) {
    return `Meta's documentation, as RAME knows it, does not rank the main model ${main.model.slice(0, 80)}, so no model is known to be more capable`;
  }
  if (documented.rank <= mainRank) {
    return `${id} is not documented as more capable than the main model ${main.model.slice(0, 80)}`;
  }
  return null;
}

/** Every catalog model, with whether it may advise this main model and why. */
export function advisorOptions(main: MainModel, catalog: readonly string[]): AdvisorOption[] {
  return catalog.slice(0, 100).map((id) => {
    const refusal = advisorRefusal(main, id, catalog);
    return { id, eligible: refusal === null, reason: refusal ?? DOCUMENTED_CAPABILITY[id]?.note ?? '' };
  });
}

/** The advisor of a new installation: Spark, as escalation always was (it cannot advise a Spark main model; Wonder is chosen by the user). */
export const DEFAULT_ADVISOR = 'muse-spark-1.3';

/** The advisor stored before this setting existed: escalation went to the selected cloud model. */
export function legacyAdvisor(cloudModel: string): string {
  return cloudModel;
}

/** A stored advisor id: '' (none) or a bounded Meta chat model id. */
export function parseAdvisorModel(value: unknown): string | null {
  if (value === '') {
    return '';
  }
  return typeof value === 'string' && isCompatibleModelId(value) ? value.trim() : null;
}

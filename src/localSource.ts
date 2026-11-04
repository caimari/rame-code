/**
 * The host side of external model servers (Ollama, LM Studio, a llama-server
 * the user runs) and of the web-access setting.
 *
 * Choosing a server never starts or stops it: RAME does not own its
 * lifecycle. A server on another computer of the private network is used
 * only after the user ticked the confirmation that prompts, history and
 * project content will go there. Scanning sends nothing but metadata
 * requests (model lists).
 */

import { invalidatePendingApproval } from './agentController.js';
import { cancelArtifactHash, checkLocalIdentity, startArtifactHash } from './localIdentityHost.js';
import { probeLocalProps } from './generationController.js';
import { classifyEndpoint, modelFitness, scanLocalServer } from './localServers.js';
import { lastScan, recordScan } from './localSourceState.js';
import { recordMissionWebRequest, validateMissionWebRequest } from './missionWeb.js';
import type { LocalSourceMessage } from './localSourceView.js';
import type { ProviderHost } from './providerTypes.js';
import { EMPTY_EXTERNAL_LOCAL, type ExternalLocalChoice } from './settingsStore.js';
import { validateSearxngUrl } from './webAccess.js';


export async function selectExternalEndpoint(host: ProviderHost, rawEndpoint: string, choice: ExternalLocalChoice = EMPTY_EXTERNAL_LOCAL): Promise<void> {
  const classified = classifyEndpoint(rawEndpoint.trim().replace(/\/+$/, ''));
  if (!classified.ok || (classified.scope === 'private' && !choice.lan)) {
    host.status = classified.ok
      ? `${classified.endpoint} is on another computer: choose it under "Model servers" and confirm that local work may be sent there.`
      : classified.error;
    await host.postState();
    return;
  }
  const endpoint = classified.endpoint;
  invalidatePendingApproval(host, 'the model server or model changed');
  host.settings = { ...host.settings, externalLocalEndpoint: endpoint, externalLocal: { ...choice } };
  host.persistSettings();
  host.localTransition({ kind: 'external-selected', endpoint });
  host.status = `External endpoint selected: ${endpoint}${choice.model ? `, model ${choice.model}` : ''}. RAME does not own its lifecycle.`;
  await probeLocalProps(host, endpoint);
  await host.postState();
}
export async function clearExternalEndpoint(host: ProviderHost): Promise<void> {
  invalidatePendingApproval(host, 'the model server or model changed');
  host.settings = { ...host.settings, externalLocalEndpoint: '', externalLocal: { ...EMPTY_EXTERNAL_LOCAL } };
  host.persistSettings();
  if (!host.localStatus().owned) {
    host.localTransition({ kind: 'external-cleared' });
  }
  host.status = 'External endpoint cleared.';
  await host.postState();
}

export async function handleLocalSourceMessage(host: ProviderHost, message: LocalSourceMessage | { type: 'selectExternalEndpoint'; endpoint: string } | { type: 'clearExternalEndpoint' }): Promise<void> {
  switch (message.type) {
    case 'selectExternalEndpoint':
      return selectExternalEndpoint(host, message.endpoint);
    case 'clearExternalEndpoint':
      return clearExternalEndpoint(host);
    case 'localServerScan': {
      host.status = 'Looking for models on the server…';
      await host.postState();
      const result = await scanLocalServer(message.endpoint);
      recordScan(host, result.ok ? { scan: result.scan, error: '' } : { scan: null, error: result.error });
      host.status = result.ok
        ? `${result.scan.kind === 'lmstudio' ? 'LM Studio' : result.scan.kind === 'ollama' ? 'Ollama' : 'A model server'} at ${result.scan.endpoint}: ${result.scan.models.length} model(s).`
        : result.error;
      await host.postState();
      return;
    }
    case 'localServerUse': {
      const scan = lastScan(host);
      const classified = classifyEndpoint(message.endpoint);
      const model = scan !== null && classified.ok && scan.endpoint === classified.endpoint ? scan.models.find((entry) => entry.id === message.model) : undefined;
      if (scan === null || model === undefined) {
        host.status = 'Look for models on that server first, then choose one of them.';
        await host.postState();
        return;
      }
      if (scan.scope === 'private' && !message.lan) {
        host.status = `${scan.endpoint} is another computer of your network. Tick the confirmation to send prompts, history and project content there, or choose a server on this computer.`;
        await host.postState();
        return;
      }
      await selectExternalEndpoint(host, scan.endpoint, { model: model.id, kind: scan.kind, tools: model.tools, context: model.loadedContext, lan: scan.scope === 'private' });
      const fitness = `${host.status} ${modelFitness(model, scan.kind).note}`.trim();
      // Record what the server says about itself and this model, for Model evidence (metadata requests only).
      await checkLocalIdentity(host);
      host.status = fitness;
      await host.postState();
      return;
    }
    case 'localIdentity':
      if (message.action === 'check') {
        return checkLocalIdentity(host);
      }
      if (message.action === 'hash') {
        // Not awaited: the view stays usable and can cancel while the file is read.
        void startArtifactHash(host);
        return;
      }
      return cancelArtifactHash(host);
    case 'missionWebSet': {
      // Kept until this Mission is authorized; validated again there and bound to its grant.
      recordMissionWebRequest(host, message.missionId, { enabled: message.enabled, maxSearches: message.maxSearches, maxFetches: message.maxFetches, domains: message.domains });
      const checked = validateMissionWebRequest({ enabled: message.enabled, maxSearches: message.maxSearches, maxFetches: message.maxFetches, domains: message.domains });
      if (!checked.ok) {
        host.status = checked.error;
        await host.postState();
      }
      return;
    }
    case 'shellAccessSet':
      host.settings = { ...host.settings, shell: { enabled: message.enabled } };
      host.persistSettings();
      host.status = message.enabled
        ? 'Terminal commands ON for Agent (run_command): each command is shown exactly and waits for your approval in every profile, Workspace full included. It runs with your permissions in the project folder: no sandbox.'
        : 'Terminal commands OFF: Agent cannot run shell commands.';
      await host.postState();
      return;
    case 'webAccessSet': {
      const url = message.searxngUrl.trim();
      if (message.search === 'searxng') {
        const checked = validateSearxngUrl(url);
        if (!checked.ok) {
          host.status = checked.error;
          await host.postState();
          return;
        }
      }
      host.settings = { ...host.settings, web: { enabled: message.enabled, search: message.search, searxngUrl: url } };
      host.persistSettings();
      host.status = message.enabled
        ? `Web access ON for Agent: web_search (${message.search === 'searxng' ? 'your SearXNG' : 'DuckDuckGo'}) and web_fetch, read-only. Each call is shown and, except in Workspace full, needs your approval.`
        : 'Web access OFF: Agent cannot search or read web pages.';
      await host.postState();
      return;
    }
  }
}

import * as vscode from 'vscode';

import { createMissionPlan, META_MODEL } from './meta-provider.js';

const API_KEY_SECRET = 'rameCode.metaModelApiKey';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('RAME Code');
  let missionRunning = false;

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('rameCode.setMetaApiKey', async () => {
      await setMetaApiKey(context.secrets);
    }),
    vscode.commands.registerCommand('rameCode.startMission', async () => {
      if (missionRunning) {
        await vscode.window.showWarningMessage('A RAME Code mission is already being planned.');
        return;
      }

      missionRunning = true;
      try {
        await startMission(context.secrets, output);
      } finally {
        missionRunning = false;
      }
    }),
  );
}

export function deactivate(): void {}

async function setMetaApiKey(secrets: vscode.SecretStorage): Promise<boolean> {
  const apiKey = await vscode.window.showInputBox({
    title: 'RAME Code — Meta Model API key',
    prompt: 'Enter a separate Meta Model API key. It is stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? 'An API key is required.' : undefined,
  });

  if (apiKey === undefined) {
    return false;
  }

  await secrets.store(API_KEY_SECRET, apiKey.trim());
  await vscode.window.showInformationMessage('RAME Code stored the API key securely.');
  return true;
}

async function startMission(
  secrets: vscode.SecretStorage,
  output: vscode.OutputChannel,
): Promise<void> {
  let apiKey = await secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      'RAME Code needs a separate Meta Model API key.',
      'Set API key',
    );
    if (choice !== 'Set API key' || !(await setMetaApiKey(secrets))) {
      return;
    }
    apiKey = await secrets.get(API_KEY_SECRET);
  }

  const goal = await vscode.window.showInputBox({
    title: 'RAME Code — Start mission',
    prompt: 'Describe the software goal. Version 0.1 sends only this text to Meta Model API.',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length < 10 ? 'Describe the goal in at least 10 characters.' : undefined,
  });
  if (goal === undefined || !apiKey) {
    return;
  }

  try {
    const plan = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `RAME Code is planning with ${META_MODEL}`,
        cancellable: true,
      },
      async (_progress, cancellation) => {
        const controller = new AbortController();
        cancellation.onCancellationRequested(() => controller.abort());
        return createMissionPlan({
          apiKey,
          goal: goal.trim(),
          signal: controller.signal,
        });
      },
    );

    output.clear();
    output.appendLine(`RAME Code mission plan — ${META_MODEL}`);
    output.appendLine('No workspace content was read or sent by this command.');
    output.appendLine('');
    output.appendLine(JSON.stringify(plan, null, 2));
    output.show(true);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      await vscode.window.showInformationMessage('RAME Code mission planning was cancelled.');
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error.';
    await vscode.window.showErrorMessage(`RAME Code could not create the plan: ${message}`);
  }
}

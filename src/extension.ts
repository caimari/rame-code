import * as vscode from 'vscode';

import { ChatRunner } from './chatRunner.js';
import { MAIN_VIEW_ID, RameCodeViewProvider } from './mainProvider.js';
import { API_KEY_SECRET } from './mainProvider.js';
import { MissionRunner } from './missionRunner.js';
import { ThreadStore } from './threadStore.js';
import { redactKeyFromText, validateGoalInput } from './webviewMessages.js';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('RAME Code');
  const missionRunner = new MissionRunner();
  const chatRunner = new ChatRunner();
  const store = new ThreadStore({
    get: (key: string) => context.globalState.get<unknown>(key),
    update: (key: string, value: unknown) =>
      context.globalState.update(key, value),
  });
  store.load();

  const mainState = {
    get: (key: string) => context.globalState.get<unknown>(key),
    update: (key: string, value: unknown) =>
      context.globalState.update(key, value),
  };
  const main = new RameCodeViewProvider(
    context.extensionUri,
    context.secrets,
    missionRunner,
    chatRunner,
    store,
    mainState,
    output,
    // Project memory and Missions live in files every window of this
    // machine shares, written under a cross-window lock.
    vscode.Uri.joinPath(context.globalStorageUri, 'shared-state').fsPath,
  );

  context.subscriptions.push(
    output,
    main,
    vscode.window.registerWebviewViewProvider(MAIN_VIEW_ID, main, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('rameCode.openPanel', async () => {
      await revealMain();
    }),
    vscode.commands.registerCommand('rameCode.newThread', async () => {
      await revealMain();
      await main.newThread();
    }),
    vscode.commands.registerCommand('rameCode.setMetaApiKey', async () => {
      await revealMain();
      await main.navigate('settings');
      await setMetaApiKey(context.secrets, main);
    }),
    vscode.commands.registerCommand('rameCode.startMission', async () => {
      await revealMain();
      if (missionRunner.isRunning || chatRunner.isRunning) {
        await vscode.window.showWarningMessage(
          'A RAME Code request is already running.',
        );
        return;
      }
      await startMissionFromPalette(context.secrets, main, output);
    }),
    context.secrets.onDidChange((event) => {
      if (event.key === API_KEY_SECRET) {
        void main.refreshHasKey();
      }
    }),
  );
}

// The provider is in `context.subscriptions`, so VS Code disposes it here:
// deactivation stops only the owned local-runtime child, never anything else.
export function deactivate(): void {}

async function revealMain(): Promise<void> {
  try {
    await vscode.commands.executeCommand(`${MAIN_VIEW_ID}.focus`);
  } catch {
    // The view may be unavailable (e.g. in tests); palette flows continue.
  }
}

async function setMetaApiKey(
  secrets: vscode.SecretStorage,
  main: RameCodeViewProvider,
): Promise<boolean> {
  const apiKey = await vscode.window.showInputBox({
    title: 'RAME Code — Meta Model API key',
    prompt:
      'Enter a separate Meta Model API key. It is stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0 ? 'An API key is required.' : undefined,
  });

  if (apiKey === undefined) {
    return false;
  }

  await secrets.store(API_KEY_SECRET, apiKey.trim());
  await main.refreshHasKey();
  await vscode.window.showInformationMessage(
    'RAME Code stored the API key securely.',
  );
  return true;
}

async function startMissionFromPalette(
  secrets: vscode.SecretStorage,
  main: RameCodeViewProvider,
  output: vscode.OutputChannel,
): Promise<void> {
  let apiKey = await secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage(
      'RAME Code needs a separate Meta Model API key.',
      'Set API key',
    );
    if (choice !== 'Set API key') {
      return;
    }
    const storedApiKey = await vscode.window.showInputBox({
      title: 'RAME Code — Meta Model API key',
      prompt:
        'Enter a separate Meta Model API key. It is stored in VS Code SecretStorage.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? 'An API key is required.' : undefined,
    });
    if (storedApiKey === undefined) {
      return;
    }
    await secrets.store(API_KEY_SECRET, storedApiKey.trim());
    apiKey = await secrets.get(API_KEY_SECRET);
  }

  const goal = await vscode.window.showInputBox({
    title: 'RAME Code — Start mission',
    prompt:
      'Describe the software goal. Only this text is sent to Meta Model API.',
    ignoreFocusOut: true,
    validateInput: (value) =>
      validateGoalInput(value).ok
        ? undefined
        : 'Describe the goal in at least 10 characters.',
  });
  if (goal === undefined || !apiKey) {
    return;
  }

  await main.refreshHasKey();
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'RAME Code is planning with the selected Meta cloud model',
        cancellable: true,
      },
      async (_progress, cancellation) => {
        cancellation.onCancellationRequested(() => main.cancelRequest());
        // Bounded behavior: only the user-entered goal text goes to the API.
        await main.sendMessage(goal.trim(), 'mission', 'cloud');
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    // Defensive: provider errors never include the key, but redact anyway.
    await vscode.window.showErrorMessage(
      `RAME Code could not create the plan: ${redactKeyFromText(message, apiKey)}`,
    );
  }
  void output;
}

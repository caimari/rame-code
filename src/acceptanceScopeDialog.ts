/**
 * The user's explicit confirmation of what a protected acceptance check
 * freezes and what it leaves writable: a modal dialog raised by the host,
 * which no model output or webview message can answer.
 */

import * as vscode from 'vscode';

const list = (files: string[]) => (files.length > 0 ? files.slice(0, 20).join(', ') + (files.length > 20 ? ` and ${files.length - 20} more` : '') : 'none');

export async function confirmAcceptanceScopeDialog(summary: { commandId: string; frozen: string[]; writable: string[]; outputs: string[]; sealed: string[] }): Promise<boolean> {
  const detail =
    `Frozen, the Mission cannot change them: ${list(summary.frozen)}.\n\n` +
    `Sealed folders, nothing may be added, changed or removed there: ${list(summary.sealed)}.\n\n` +
    `Writable, the check loads or reads them as the code under test: ${list(summary.writable)}.\n\n` +
    `Outputs, the check reads them and they do not exist yet: ${list(summary.outputs)}.\n\n` +
    'Every other file of the project is recorded now. If the Mission changes one, RAME does not count the check until you review it.\n\n' +
    'If a writable file or an output is part of the check (test data, expected values, helpers), cancel and add it to the acceptance files: otherwise the Mission could pass by changing it.';
  const choice = await vscode.window.showWarningMessage(`Protect the acceptance check ${summary.commandId} with this scope?`, { modal: true, detail }, 'Protect and authorize');
  return choice === 'Protect and authorize';
}

/**
 * Scope review after a host run of a protected check: files changed outside
 * the scope the user authorized, which the host cannot attribute. The run is
 * counted only if the user approves them as writable code under test.
 */
export async function confirmAcceptanceScopeChangeDialog(review: { commandId: string; changes: Array<{ path: string; change: 'changed' | 'added' | 'removed' }> }): Promise<boolean> {
  const tests = review.changes.filter((entry) => /(?:^|\/)(?:tests?|spec|fixtures?|__tests__)\/|\.(?:test|spec)\.|\.json$/i.test(entry.path));
  const detail =
    `The Mission changed files outside the scope you authorized: ${list(review.changes.map((entry) => `${entry.path} (${entry.change})`))}.\n\n` +
    'RAME cannot prove that the acceptance check does not depend on them. Approve them only if they are code under test, not tests, test data or expected values.' +
    (tests.length > 0 ? `\n\nWarning: ${list(tests.map((entry) => entry.path))} look like tests or data.` : '');
  const choice = await vscode.window.showWarningMessage(`Count the acceptance check ${review.commandId} with these changes?`, { modal: true, detail }, 'Approve as code under test');
  return choice === 'Approve as code under test';
}

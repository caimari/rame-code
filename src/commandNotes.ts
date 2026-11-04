/**
 * Notes for the approval card of a terminal command (see shellTool.ts).
 * No imports, so the tool descriptions in agentHost.ts can use it.
 */

/**
 * What the approval card adds under the command: what the line does that is
 * easy to miss. Heuristic and incomplete by nature; it never allows anything.
 */
export function commandNotes(command: string): string[] {
  const notes: string[] = [];
  const parts = command.split(/&&|\|\||;|\n/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    notes.push(`runs ${parts.length} commands in a row`);
  }
  if (/(?<!\|)\|(?!\|)/.test(command)) {
    notes.push('pipes output into another command');
  }
  if (/\$\(|`/.test(command)) {
    notes.push('runs a command inside the command ($(...) or backticks)');
  }
  if (/(?:^|[\s;&|(])(?:\.{0,2}\/[\w./-]+\.(?:sh|bash|ps1|py|js|mjs|cjs|rb|pl)|(?:bash|sh|zsh|python3?|node|ruby|perl|pwsh|powershell)\s+(?!-)[\w./-]+\.\w+|npm\s+(?:run|start|test)|npx\s|yarn\s+\w|pnpm\s+\w|make\b)/.test(command)) {
    notes.push('runs a script or package script whose content this card does not show');
  }
  if (/\bsudo\b|\brunas\b|Start-Process[^\n]*-Verb\s+RunAs/i.test(command)) {
    notes.push('asks for administrator rights');
  }
  if (/\b(?:curl|wget|Invoke-WebRequest|iwr|ssh|scp|rsync|nc|ftp)\b|https?:\/\//i.test(command)) {
    notes.push('uses the network');
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\b|\bpip3?\s+install\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b|\bcargo\s+install\b|\bnpx\b/.test(command)) {
    notes.push('installs or downloads software (its install scripts can run code)');
  }
  if (/(?:^|[\s>])(?:>|>>|tee\s+)\s*(?:\/|~|\$HOME|\.\.\/|[A-Za-z]:\\)/.test(command) || /\b(?:rm|mv|cp|chmod|chown)\b[^;&|\n]*\s(?:\/|~|\$HOME|\.\.\/)/.test(command)) {
    notes.push('may change files outside the project folder');
  }
  if (/\brm\b|\bdel\b|Remove-Item|\bgit\s+(?:reset\s+--hard|clean|push|checkout\s+--)/i.test(command)) {
    notes.push('deletes files or rewrites git state');
  }
  return notes;
}

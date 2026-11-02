import { REGEX_SEARCH_TIMEOUT_MESSAGE } from './agentHost.js';

/**
 * Content-free one-line outcome for Activity/audit. Tool output may hold
 * file text or matched lines, so only its structural first line (or a
 * count) is kept.
 */
export function summarizeToolResult(tool: string, resultText: string): string {
  const lines = resultText.split('\n');
  let summary: string;
  if (tool === 'search_text') {
    summary = resultText.trim() === '(no matches)' ? 'no matches' : `${lines.filter((line) => line.length > 0).length} matching line(s)`;
  } else if (tool === 'list_files') {
    summary = resultText.trim() === '(empty directory)' ? 'empty directory' : `${lines.filter((line) => line.length > 0).length} entr(ies) listed`;
  } else if (tool === 'inspect_workspace') {
    const fields = new Map(
      lines.flatMap((line) => {
        const match = /^(directory|files|directories|totalBytes|entriesVisited|truncated): ([A-Za-z0-9._/-]{1,120}|\d+|true|false)$/.exec(line);
        return match ? [[match[1], match[2]] as const] : [];
      }),
    );
    const required = ['directory', 'files', 'directories', 'totalBytes', 'entriesVisited', 'truncated'] as const;
    summary = required.every((field) => fields.has(field))
      ? required.map((field) => `${field}=${fields.get(field)}`).join(' ')
      : 'workspace inspection completed';
  } else if (tool === 'read_file') {
    summary = `read ${(lines[0] ?? '').replace(/^path: /, '')}`;
  } else if (tool === 'read_decisions') {
    const end = lines.findIndex((line) => line === 'VERIFIED FILES:');
    const inForce = lines.slice(1, end < 0 ? undefined : end).filter((line) => /^- [a-z]/.test(line)).length;
    summary = `read project memory (${inForce} decision(s) in force)`;
  } else {
    summary = lines[0] ?? '';
  }
  return summary.slice(0, 120);
}

export const REPLACE_NOT_FOUND_MESSAGE = 'The text to replace is not in the file; read it again and copy the fragment exactly.';
export const REPLACE_NOT_UNIQUE_MESSAGE = 'The text to replace appears more than once; include more surrounding lines so it is unique.';

/** Failures with no side effects that the bounded loop may inspect and repair. */
export function isRecoverableAgentToolError(detail: string): boolean {
  return [
    REPLACE_NOT_FOUND_MESSAGE,
    REPLACE_NOT_UNIQUE_MESSAGE,
    'That file does not exist.',
    'That directory does not exist.',
    'The source file does not exist.',
    'The target already exists; inspect and re-propose the action.',
    'The destination already exists; overwrite is not allowed.',
    'The source changed; re-read and re-propose the action.',
    'The file changed; re-read and re-propose the action.',
    REGEX_SEARCH_TIMEOUT_MESSAGE,
  ].includes(detail);
}

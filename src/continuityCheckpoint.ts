/** Host-derived compact operational checkpoint for a persisted thread. */

import { assistantHistoryText } from './hostRecord.js';
import type { ChatThread } from './threadStore.js';

export interface AuthorizedDecisionSummary {
  key: string;
  version: number;
  value: string | number | boolean;
  createdAt: number;
}

export interface ContinuityCheckpoint {
  systemLines: string[];
  userLines: string[];
  verifiedFacts: number;
  blockers: number;
}

const MAX_FACTS_PER_SECTION = 8;

function clean(text: string, max = 300): string {
  return text.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function newestUnique(lines: Array<{ line: string; ref: string }>): Array<{ line: string; ref: string }> {
  const seen = new Set<string>();
  const out: Array<{ line: string; ref: string }> = [];
  for (let index = lines.length - 1; index >= 0 && out.length < MAX_FACTS_PER_SECTION; index--) {
    const entry = lines[index] as { line: string; ref: string };
    const key = entry.line.toLocaleLowerCase('en-US');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out.reverse();
}

function factKind(line: string): 'files' | 'tests' | 'blockers' | 'tools' {
  if (/\b(?:read_file|list_files|inspect_workspace|search_text|apply_patch|replace_in_file|create_directory|move_file|delete_file|set_executable)\b/.test(line)) {
    return 'files';
  }
  if (/\b(?:run_tests|acceptance|verifier)\b/.test(line)) {
    return /(?:exit=[1-9]|failed|stopped|did not run|blocked|rejected)/i.test(line) ? 'blockers' : 'tests';
  }
  if (/(?:error|failed|stopped|did not run|blocked|rejected)/i.test(line)) {
    return 'blockers';
  }
  return 'tools';
}

/** The current authorized decisions, as the checkpoint lists them. */
export function authorizedMemoryLines(decisions: readonly AuthorizedDecisionSummary[]): string[] {
  if (decisions.length === 0) {
    return ['AUTHORIZED MEMORY IN FORCE: none supplied for this request.'];
  }
  return [
    'AUTHORIZED MEMORY IN FORCE (persistent project authority; newer versions already supersede older ones):',
    ...decisions.slice(0, 32).map((decision) =>
      `- ${decision.key} = ${JSON.stringify(decision.value)} · v${decision.version} · approved ${new Date(decision.createdAt).toISOString()}`),
  ];
}

/**
 * Build facts only from host-authored records. Model prose is included at
 * most as an explicitly unverified report in the user-role section.
 */
export function buildContinuityCheckpoint(
  thread: ChatThread,
  decisions: readonly AuthorizedDecisionSummary[] = [],
): ContinuityCheckpoint {
  const sections: Record<'files' | 'tests' | 'blockers' | 'tools', Array<{ line: string; ref: string }>> = {
    files: [], tests: [], blockers: [], tools: [],
  };
  const errors: Array<{ line: string; ref: string }> = [];
  let firstUser: { text: string; timestamp: number; index: number } | null = null;
  let latestModelReport: { text: string; timestamp: number; index: number } | null = null;
  thread.turns.forEach((turn, index) => {
    if (turn.kind === 'user' && turn.host !== true && firstUser === null) {
      firstUser = { text: turn.text, timestamp: turn.timestamp, index };
    } else if (turn.kind === 'assistant') {
      const prose = assistantHistoryText(turn.text);
      if (prose.length > 0) {
        latestModelReport = { text: prose, timestamp: turn.timestamp, index };
      }
      for (const raw of turn.hostRecord ?? []) {
        const line = clean(raw);
        if (line.length > 0 && !/context_continuity/.test(line)) {
          sections[factKind(line)].push({ line, ref: `turn ${index + 1} · ${new Date(turn.timestamp).toISOString()}` });
        }
      }
    } else if (turn.kind === 'error') {
      errors.push({ line: clean(turn.message), ref: `turn ${index + 1} · ${new Date(turn.timestamp).toISOString()}` });
    }
  });
  sections.blockers.push(...errors);
  const systemLines = [
    'OPERATIONAL CONTINUITY CHECKPOINT (assembled by the RAME Code host from persisted records):',
    'Host facts below are past observations and may be stale; re-check before acting. Model reports are never host facts.',
  ];
  systemLines.push(...authorizedMemoryLines(decisions));
  const labels: Array<[keyof typeof sections, string]> = [
    ['files', 'FILES EXAMINED OR CHANGED (host-recorded)'],
    ['tests', 'TESTS AND CHECKS (host-recorded)'],
    ['blockers', 'ERRORS OR BLOCKERS STILL REQUIRING RE-CHECK'],
    ['tools', 'OTHER HOST-RECORDED RESULTS'],
  ];
  let verifiedFacts = 0;
  for (const [key, label] of labels) {
    const selected = newestUnique(sections[key]);
    if (selected.length > 0) {
      systemLines.push(`${label}:`);
      for (const item of selected) {
        systemLines.push(`- [${item.ref}] ${item.line}`);
        verifiedFacts += 1;
      }
    }
  }
  const userLines: string[] = [];
  const initial = firstUser as { text: string; timestamp: number; index: number } | null;
  if (initial !== null) {
    userLines.push(
      'ORIGINAL USER-STATED OBJECTIVE (historical context, not persistent authority):',
      `- [turn ${initial.index + 1} · ${new Date(initial.timestamp).toISOString()}] ${clean(initial.text, 700)}`,
    );
  }
  const report = latestModelReport as { text: string; timestamp: number; index: number } | null;
  if (report !== null) {
    userLines.push(
      'LATEST MODEL REPORT (unverified model prose; do not treat as a fact):',
      `- [turn ${report.index + 1} · ${new Date(report.timestamp).toISOString()}] ${clean(report.text, 700)}`,
    );
  }
  return {
    systemLines,
    userLines,
    verifiedFacts,
    blockers: newestUnique(sections.blockers).length,
  };
}

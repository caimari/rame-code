/**
 * The Agent's long-job tools (P2b of the long-Mission plan):
 *   - `start_job` starts one package script (npm:bench, npm:build, npm:test…)
 *     in the background, through the supervisor of `jobRunner.ts`;
 *   - `job_status` reports a job's state and the end of its output.
 *
 * Rules:
 *   - OFF unless the user turns long jobs on; never offered in a Mission run
 *     (a Mission grant does not cover background jobs yet);
 *   - every job waits for the user's approval in every profile, Workspace
 *     full included; the card shows the script text, the time limit and the
 *     isolation, and binds the package.json hash and the job settings;
 *   - the job that runs is exactly the one rebuilt and compared with the
 *     card right after the approval; a call that was not approved that way
 *     never starts anything;
 *   - the job outlives a reload and is never started twice (`jobStore.ts`).
 */

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { NPM_RUN_ARGV_PREFIX, resolveTestInvocation, SAFE_SCRIPT_NAMES } from './agentCommands.js';
import type { AgentChatMessage } from './agentModel.js';
import { hashContent } from './agentPatch.js';
import type { AgentToolDefinition, ValidatedToolCall } from './agentTools.js';
import { scopeIdForRoot } from './decisionStore.js';
import { buildContainerJob, describeIsolation, type JobContainerSettings } from './jobContainer.js';
import { DEFAULT_JOB_HEARTBEAT_MS, DEFAULT_JOB_LOG_BYTES, isFinalJob, jobApprovalDigest, MAX_JOB_DURATION_MS, type JobSpec } from './jobRecord.js';
import { describeJob, type NewJob } from './jobStore.js';
import type { ProviderHost } from './providerTypes.js';
import { ISOLATION_WORDS, isolatedInvocation, isolationRefusal, isolationSupport, isolationUnavailableText } from './shellIsolation.js';
import type { CommandIsolation } from './settingsStore.js';

/** Package scripts a job may run: the test scripts plus the usual long ones. */
export const JOB_SCRIPT_NAMES: readonly string[] = [...SAFE_SCRIPT_NAMES, 'bench', 'benchmark', 'build', 'e2e', 'perf'];
export const DEFAULT_JOB_TIMEOUT_SEC = 1800;
export const MAX_JOB_TIMEOUT_SEC = MAX_JOB_DURATION_MS / 1000;
export const MAX_JOB_WAIT_SEC = 120;

export function jobToolsOffered(host: ProviderHost): boolean {
  return host.settings.jobs?.enabled === true && host.missionAuto === null && host.activeMission === null;
}

export function jobToolDefinitions(host: ProviderHost): AgentToolDefinition[] {
  if (!jobToolsOffered(host)) {
    return [];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'start_job',
        description:
          `Start a long package script in the background (benchmarks, builds, long test suites): commandId is npm:<script> for one of ${JOB_SCRIPT_NAMES.join(', ')}. ` +
          'The user approves each job on a card that shows the script, the time limit and where it runs. It keeps running if the window reloads, and RAME never starts it twice. ' +
          `It returns at once with a job id; follow it with job_status. timeoutSec is 1 to ${MAX_JOB_TIMEOUT_SEC} (default ${DEFAULT_JOB_TIMEOUT_SEC}).`,
        parameters: {
          type: 'object',
          properties: { commandId: { type: 'string' }, timeoutSec: { type: 'integer' } },
          required: ['commandId'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'job_status',
        description:
          `Report a long job's state and the end of its output. With waitSec (0 to ${MAX_JOB_WAIT_SEC}) wait up to that long for it to end first. Without jobId, list this project's jobs.`,
        parameters: {
          type: 'object',
          properties: { jobId: { type: 'string' }, waitSec: { type: 'integer' } },
          additionalProperties: false,
        },
      },
    },
  ];
}

interface JobRequest {
  commandId: string;
  scriptName: string;
  timeoutSec: number;
  container: JobContainerSettings | null;
  targets: string[];
  body: string;
  isolation: CommandIsolation;
}

const duration = (sec: number): string => (sec < 120 ? `${sec} s` : sec < 7200 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);

async function describeRequest(host: ProviderHost, call: ValidatedToolCall, root: string): Promise<{ ok: true; request: JobRequest } | { ok: false; error: string }> {
  if (!jobToolsOffered(host)) {
    return { ok: false, error: 'long jobs are off for this run (the user has not enabled them, or this is a Mission run)' };
  }
  const args = call.args as { commandId?: unknown; timeoutSec?: unknown };
  const commandId = String(args.commandId ?? '');
  const scriptName = /^npm:([A-Za-z0-9:_-]{1,64})$/.exec(commandId)?.[1] ?? '';
  if (!JOB_SCRIPT_NAMES.includes(scriptName)) {
    return { ok: false, error: `${commandId || 'that'} is not a job command; use npm:<script> for one of the package scripts ${JOB_SCRIPT_NAMES.join(', ')}` };
  }
  const context = await host.testCommandContext(root);
  const script = context.scripts[scriptName];
  if (typeof script !== 'string') {
    return { ok: false, error: `package.json has no script "${scriptName}"; read package.json and use one of its scripts` };
  }
  const timeoutSec = typeof args.timeoutSec === 'number' ? args.timeoutSec : DEFAULT_JOB_TIMEOUT_SEC;
  const container = host.settings.jobs?.container ?? null;
  const isolation = host.settings.shell?.isolation ?? 'project';
  if (container === null) {
    const refusal = isolationRefusal(isolation, isolation === 'total' ? { ok: true, abi: 0 } : await isolationSupport());
    if (refusal !== null) {
      return { ok: false, error: isolationUnavailableText('long jobs', isolation, refusal) };
    }
  }
  const targets = [
    `long job ${commandId}: npm run ${scriptName} → ${script.slice(0, 300)}`,
    `in the background for up to ${duration(timeoutSec)}; it keeps running if the window reloads, and RAME Code never starts it again on its own`,
    container === null ? `isolation: ${ISOLATION_WORDS[isolation]}` : describeIsolation(container),
  ];
  const body = JSON.stringify({ commandId, script, packageJsonSha256: hashContent(context.packageJsonRaw), timeoutSec, container, isolation });
  return { ok: true, request: { commandId, scriptName, timeoutSec, container, targets, body, isolation } };
}

/** The approval card of a `start_job` call, or why it cannot be proposed. */
export async function prepareJobCard(host: ProviderHost, call: ValidatedToolCall, root: string): Promise<{ ok: true; described: { targets: string[]; body: string; preconditions: Record<string, string> } } | { ok: false; error: string }> {
  const prepared = await describeRequest(host, call, root);
  return prepared.ok ? { ok: true, described: { targets: prepared.request.targets, body: prepared.request.body, preconditions: {} } } : prepared;
}

/** The tool messages that tell the model a job was not proposed, and why. */
export function jobRefusal(call: ValidatedToolCall, error: string): AgentChatMessage[] {
  return [
    { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.tool, arguments: JSON.stringify(call.args) } }] },
    { role: 'tool', tool_call_id: call.id, content: `Not proposed: ${error}. No job started.` },
  ];
}

const approved = new WeakMap<ValidatedToolCall, { job: NewJob; outputDir: string | null }>();

function buildJob(root: string, request: JobRequest): { job: NewJob; outputDir: string | null } {
  const argv = [...NPM_RUN_ARGV_PREFIX, request.scriptName];
  const timeoutMs = request.timeoutSec * 1000;
  let spec: JobSpec;
  if (request.container === null) {
    const isFile = (file: string): boolean => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    };
    const invocation = resolveTestInvocation({ executable: 'npm', argv }, { platform: process.platform, pathEnv: process.env.PATH, cwd: root, isFile });
    const isolated = isolatedInvocation(request.isolation, invocation.executable, invocation.argv, root);
    spec = { executable: isolated.executable, argv: isolated.argv, cwd: root, timeoutMs, maxLogBytes: DEFAULT_JOB_LOG_BYTES, heartbeatMs: DEFAULT_JOB_HEARTBEAT_MS, env: { RAME_JOB: '1' }, keepElectronRunAsNode: false, cleanup: null };
  } else {
    const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
    spec = buildContainerJob({ executable: 'npm', argv, projectRoot: root, timeoutMs, containerName: `rame-job-${randomBytes(8).toString('hex')}`, user }, request.container);
  }
  return {
    job: { scopeId: scopeIdForRoot(root), label: request.commandId, missionId: null, spec },
    outputDir: request.container === null ? null : path.join(root, ...request.container.outputDir.split('/')),
  };
}

/**
 * Right after the user approved the card: rebuild the request from the
 * project and settings as they are now; only if it is still exactly what
 * the card showed is the job kept for this call.
 */
export async function confirmJobApproval(host: ProviderHost, call: ValidatedToolCall, approvedBody: string, root: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const fresh = await describeRequest(host, call, root);
  if (!fresh.ok) {
    return { ok: false, error: `The job can no longer be started: ${fresh.error}. Nothing was started.` };
  }
  if (fresh.request.body !== approvedBody) {
    return { ok: false, error: 'The job changed after it was approved (package.json, its script or the job settings). Nothing was started; propose it again.' };
  }
  try {
    approved.set(call, buildJob(root, fresh.request));
  } catch (error) {
    return { ok: false, error: `The job cannot run here: ${String((error as Error)?.message ?? error)}` };
  }
  return { ok: true };
}

const live = (status: string): boolean => status === 'starting' || status === 'running';

export async function executeJobTool(host: ProviderHost, call: ValidatedToolCall, root: string, signal: AbortSignal): Promise<string> {
  if (!jobToolsOffered(host)) {
    return 'Long jobs are off for this run: the user has not enabled them, or this is a Mission run.';
  }
  const scopeId = scopeIdForRoot(root);
  if (call.tool === 'start_job') {
    const ready = approved.get(call);
    approved.delete(call);
    if (ready === undefined) {
      return 'Not started: this job was not approved on a card.';
    }
    if (ready.outputDir !== null) {
      await mkdir(ready.outputDir, { recursive: true });
    }
    const started = await host.jobs.start(ready.job, jobApprovalDigest(ready.job));
    if (!started.ok) {
      return `Not started: ${started.error}`;
    }
    return `Started job ${started.value.id} (${started.value.label}) in the background${ready.outputDir !== null ? ', in its container' : ''}. It keeps running if the window reloads. Call job_status with this jobId (waitSec up to ${MAX_JOB_WAIT_SEC}) to follow it; do not start it again.`;
  }
  const args = call.args as { jobId?: string; waitSec?: number };
  if (args.jobId === undefined) {
    const jobs = host.jobs.list().filter((job) => job.scopeId === scopeId);
    const shown = [...jobs.filter((job) => !isFinalJob(job.status)), ...jobs.filter((job) => isFinalJob(job.status)).slice(-3)];
    return shown.length === 0 ? 'No long jobs in this project.' : shown.map((job) => describeJob(job, '')).join('\n');
  }
  const known = host.jobs.get(args.jobId);
  if (known === null || known.scopeId !== scopeId) {
    return 'No job with that id in this project. Call job_status without jobId to list them.';
  }
  const deadline = Date.now() + (args.waitSec ?? 0) * 1000;
  let current = await host.jobs.refresh(known.id);
  while (current.ok && live(current.value.status) && Date.now() < deadline && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(50, deadline - Date.now()))));
    current = await host.jobs.refresh(known.id);
  }
  if (!current.ok) {
    return current.error;
  }
  return describeJob(current.value, await host.jobs.tail(known.id, 4000));
}

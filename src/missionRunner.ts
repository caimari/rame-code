/**
 * Shared mission execution with cancellation and concurrent-run prevention.
 * Used by both the command-palette flow and the webview panel so the two
 * entry points cooperate instead of racing each other.
 */

import {
  createMissionPlanWithUsage,
  type CreateMissionPlanOptions,
  type MissionPlanResult,
} from './meta-provider.js';
import type { MissionPlan } from './types.js';

export interface StartMissionInput {
  apiKey: string;
  goal: string;
  fetchImpl?: CreateMissionPlanOptions['fetchImpl'];
  endpoint?: string;
  model?: string;
  generation?: CreateMissionPlanOptions['generation'];
}

export class MissionRunner {
  private controller: AbortController | null = null;

  get isRunning(): boolean {
    return this.controller !== null;
  }

  /**
   * Run one mission. Rejects when another mission is already running.
   * Only the caller-supplied goal text reaches the provider; this runner
   * never reads workspace files and never runs shell commands.
   *
   * Legacy compatibility path: returns only the plan and drops usage.
   * Prefer {@link startWithUsage} so callers can record real usage.
   */
  async start(input: StartMissionInput): Promise<MissionPlan> {
    const result = await this.startWithUsage(input);
    return result.plan;
  }

  /**
   * Run one mission and return the real plan plus defensively parsed usage.
   * Cancellation/concurrency-safe: at most one in-flight run; `cancel()`
   * aborts it; the controller slot is cleared only by its owner so a
   * late-finishing run cannot clear a newer run.
   */
  async startWithUsage(input: StartMissionInput): Promise<MissionPlanResult> {
    if (this.controller !== null) {
      throw new Error('A RAME Code mission is already running.');
    }
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await createMissionPlanWithUsage({
        apiKey: input.apiKey,
        goal: input.goal,
        signal: controller.signal,
        fetchImpl: input.fetchImpl,
        endpoint: input.endpoint,
        model: input.model,
        generation: input.generation,
      });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  /** Cancel the running mission. Returns false when nothing was running. */
  cancel(): boolean {
    if (this.controller === null) {
      return false;
    }
    this.controller.abort();
    return true;
  }
}

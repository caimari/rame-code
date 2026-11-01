/**
 * Single-flight conversational runner with cancellation.
 *
 * Free of the `vscode` API so it can be unit tested with plain `node:test`.
 * Mirrors {@link MissionRunner} semantics for Chat-mode prose calls:
 * at most one in-flight request; `cancel()` aborts it.
 */

export interface ChatCallInput {
  signal: AbortSignal;
}

export class ChatRunner {
  private controller: AbortController | null = null;

  get isRunning(): boolean {
    return this.controller !== null;
  }

  /**
   * Run one conversational call. `work` receives the abort signal and
   * returns the assistant text. Rejects when another call is running.
   */
  async start(work: (input: ChatCallInput) => Promise<string>): Promise<string> {
    if (this.controller !== null) {
      throw new Error('A RAME Code request is already running.');
    }
    const controller = new AbortController();
    this.controller = controller;
    try {
      return await work({ signal: controller.signal });
    } finally {
      if (this.controller === controller) {
        this.controller = null;
      }
    }
  }

  /** Cancel the running call. Returns false when nothing was running. */
  cancel(): boolean {
    if (this.controller === null) {
      return false;
    }
    this.controller.abort();
    return true;
  }
}

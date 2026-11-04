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
  private closed = false;

  /** For a disposed window: cancels any running call and starts no new one. */
  close(): void {
    this.closed = true;
    this.cancel();
  }

  get isRunning(): boolean {
    return this.controller !== null;
  }

  /**
   * Run one conversational call. `work` receives the abort signal and
   * returns its result (the assistant text, or a structured reply). Rejects
   * when another call is running.
   */
  async start<T = string>(work: (input: ChatCallInput) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error('This RAME Code window was closed or reloaded; nothing was sent.');
    }
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

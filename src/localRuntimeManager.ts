import { spawn, type ChildProcess } from 'node:child_process';

import {
  STARTUP_TIMEOUT_MS,
  buildLlamaServerArgs,
  initialLocalRuntimeStatus,
  loopbackEndpoint,
  nextLocalRuntimeStatus,
  sanitizeDiagnostics,
  type LocalRuntimeSettings,
  type LocalRuntimeStatus,
} from './localRuntime.js';

const MAX_DIAGNOSTIC_BYTES = 8192;

export interface LocalRuntimeManagerPort {
  publish(status: LocalRuntimeStatus, message: string): Promise<void>;
  probe(endpoint: string): Promise<void>;
  isBusy(): boolean;
  idleTimeoutSeconds(): number;
}

/** Owns exactly one spawned llama-server process and never kills by name/port. */
export class LocalRuntimeManager {
  private child: ChildProcess | null = null;
  private stderrTail: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private current: LocalRuntimeStatus = initialLocalRuntimeStatus();

  constructor(private readonly port: LocalRuntimeManagerPort) {}

  get status(): LocalRuntimeStatus {
    return this.current;
  }

  replaceStatus(status: LocalRuntimeStatus): void {
    this.current = status;
  }

  async start(settings: LocalRuntimeSettings): Promise<void> {
    if (this.current.lifecycle === 'running' || this.current.lifecycle === 'starting') {
      await this.port.publish(this.current, 'The local runtime is already starting or running.');
      return;
    }
    if (this.current.lifecycle === 'stopping') {
      await this.port.publish(this.current, 'The local runtime is stopping. Try again in a moment.');
      return;
    }
    const endpoint = loopbackEndpoint(settings.port);
    this.current = nextLocalRuntimeStatus(this.current, { kind: 'start-requested', endpoint });
    await this.port.publish(this.current, `Starting the local runtime on ${endpoint}…`);

    let child: ChildProcess;
    try {
      child = spawn(settings.executablePath, buildLlamaServerArgs(settings), {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch {
      this.current = nextLocalRuntimeStatus(this.current, { kind: 'health-failed' });
      await this.port.publish(this.current, 'Could not start the local runtime executable.');
      return;
    }
    this.child = child;
    this.stderrTail = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      const joined = `${this.stderrTail.join('\n')}\n${chunk.toString('utf8')}`.slice(-MAX_DIAGNOSTIC_BYTES);
      this.stderrTail = joined.split('\n').slice(-40);
    });
    child.on('error', () => {
      if (this.child === child) {
        this.child = null;
        this.clearIdleTimer();
        this.current = this.stoppedWithDiagnostics();
        void this.port.publish(this.current, 'Could not start the local runtime executable.');
      }
    });
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.clearIdleTimer();
        if (['running', 'starting', 'stopping'].includes(this.current.lifecycle)) {
          this.current = this.stoppedWithDiagnostics();
          void this.port.publish(this.current, 'The local runtime stopped.');
        }
      }
    });

    const healthy = await this.waitForHealth(endpoint, STARTUP_TIMEOUT_MS);
    if (this.child !== child) {
      return;
    }
    if (!healthy) {
      this.stopOwnedChild();
      this.current = nextLocalRuntimeStatus(this.current, { kind: 'health-failed' });
      this.current = { ...this.current, diagnostics: sanitizeDiagnostics(this.stderrTail) };
      await this.port.publish(this.current, `The local runtime did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s.`);
      return;
    }
    this.current = nextLocalRuntimeStatus(this.current, { kind: 'started', endpoint });
    await this.port.publish(this.current, `Local runtime running on ${endpoint}.`);
    this.armIdleShutdown();
    await this.port.probe(endpoint);
  }

  async stop(): Promise<void> {
    if (!this.current.owned || !this.child) {
      await this.port.publish(this.current, 'Nothing owned to stop. An external endpoint is never stopped by RAME.');
      return;
    }
    this.current = nextLocalRuntimeStatus(this.current, { kind: 'stop-requested' });
    await this.port.publish(this.current, 'Stopping the local runtime…');
    this.stopOwnedChild();
    this.current = this.stoppedWithDiagnostics();
    await this.port.publish(this.current, 'Local runtime stopped.');
  }

  armIdleShutdown(): void {
    this.clearIdleTimer();
    const idleSec = this.port.idleTimeoutSeconds();
    if (!this.current.owned || idleSec <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (this.port.isBusy()) {
        this.armIdleShutdown();
        return;
      }
      void this.stop();
    }, idleSec * 1000);
    (this.idleTimer as unknown as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    this.stopOwnedChild();
  }

  private stoppedWithDiagnostics(): LocalRuntimeStatus {
    return {
      ...nextLocalRuntimeStatus(this.current, { kind: 'stopped' }),
      diagnostics: sanitizeDiagnostics(this.stderrTail),
    };
  }

  private stopOwnedChild(): void {
    const owned = this.child;
    this.child = null;
    this.clearIdleTimer();
    try {
      owned?.kill();
    } catch {
      // The owned child may already have exited.
    }
  }

  private async waitForHealth(endpoint: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child === null) {
        return false;
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        try {
          const response = await fetch(`${endpoint}/health`, { signal: controller.signal });
          if (response.ok) {
            return true;
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Retry until the bounded startup deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

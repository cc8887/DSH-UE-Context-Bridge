/**
 * ipc.ts — plugin-side gateway client.
 *
 * The gateway is a child process owned by this plugin. Protocol traffic uses a
 * dedicated stdio (JSON-lines); logs go to stderr.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type {
  IpcIdentity,
  IpcMethod,
  IpcRequest,
  IpcResponse,
} from '@ue-bridge/contracts/ipc';

export interface GatewayClientOptions {
  command: string;
  args: string[];
  cwd: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

export class GatewayClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, Pending>();
  private buffer = '';
  private seq = 0;
  private stderrTail: string[] = [];
  private restartHooks: Array<() => void> = [];

  constructor(private readonly options: GatewayClientOptions) {}

  /** Notified whenever the child is (re)started, so caches can be dropped. */
  onRestart(hook: () => void): void {
    this.restartHooks.push(hook);
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Recent gateway stderr, bounded, surfaced for diagnostics only. */
  diagnostics(): string {
    return this.stderrTail.join('\n');
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail.push(chunk.trimEnd());
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });

    // A fresh process has an empty catalog; let owners drop cached state.
    for (const hook of this.restartHooks) hook();

    this.child.on('exit', (code) => {
      // Leaving requests pending would hang the caller forever. Fail fast and
      // mark the client recoverable so the next call restarts the gateway.
      for (const [, p] of this.pending) {
        p.reject(
          Object.assign(new Error(`gateway exited (code ${code}) before responding`), {
            envelope: { code: 'EDITOR_UNAVAILABLE', message: 'gateway exited', retry: 'recoverable' },
          }),
        );
      }
      this.pending.clear();
      this.child = null;
      this.stderrTail = [];
    });

    this.child.on('error', (err) => {
      for (const [, p] of this.pending) {
        p.reject(
          Object.assign(new Error(`gateway failed to spawn: ${err.message}`), {
            envelope: { code: 'EDITOR_UNAVAILABLE', message: err.message, retry: 'recoverable' },
          }),
        );
      }
      this.pending.clear();
      this.child = null;
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let parsed: IpcResponse;
    try {
      parsed = JSON.parse(line) as IpcResponse;
    } catch {
      return;
    }
    const entry = this.pending.get(parsed.id);
    if (!entry) return;
    this.pending.delete(parsed.id);
    if ('error' in parsed) {
      entry.reject(Object.assign(new Error(parsed.error.message), { envelope: parsed.error }));
      return;
    }
    entry.resolve(parsed.result);
  }

  async call<M extends IpcMethod, T>(
    method: M,
    params: unknown,
    identity: IpcIdentity,
    signal?: AbortSignal,
  ): Promise<T> {
    // Recover from a gateway that exited: a crash must not make the plugin
    // permanently unusable for the rest of the session.
    if (!this.child) this.start();
    this.seq += 1;
    const id = `req-${this.seq}`;
    const request: IpcRequest<M, unknown> = {
      jsonrpc: '2.0',
      id,
      method,
      params,
      identity,
    };

    const value = await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new Error('cancelled before gateway response'));
      };
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.child?.stdin.write(`${JSON.stringify(request)}\n`);
    });

    return value as T;
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill();
    this.child = null;
  }
}

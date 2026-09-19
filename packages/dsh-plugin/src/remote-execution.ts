/**
 * remote-execution.ts — Python execution over the engine's own protocol.
 *
 * The Unreal MCP plugin exposes no Python surface and must not be modified, so
 * Python mode talks to PythonScriptPlugin's built-in remote execution instead:
 * UDP multicast discovery, then a TCP command channel.
 *
 * This is a stock protocol client. It reads no engine source and writes none,
 * so dsh stays non-invasive against the UE tree.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const PROTOCOL_VERSION = 1;
const PROTOCOL_MAGIC = 'ue_py';

export interface RemoteEndpoint {
  multicastGroup: string;
  port: number;
  bindAddress: string;
}

/**
 * Endpoint matching the engine's stock defaults.
 *
 * Used when no registry entry exists. dsh assigns a distinct port per editor
 * instance once the instance is registered, so this is only the fallback.
 */
export const DEFAULT_ENDPOINT: RemoteEndpoint = {
  multicastGroup: '239.0.0.1',
  port: 6766,
  bindAddress: '127.0.0.1',
};

export interface DiscoveredEditor {
  nodeId: string;
  projectName?: string;
  projectRoot?: string;
  engineVersion?: string;
}

export interface PythonRunResult {
  success: boolean;
  /** Captured log output; on failure this carries the traceback. */
  stdout: string;
  /** Evaluation result: "None" for statements, or the traceback on failure. */
  result: string;
  /** Structured log entries as sent by the editor. */
  output: Array<{ type: string; output: string }>;
}

export class RemoteExecutionError extends Error {
  constructor(
    message: string,
    readonly code: 'DISCOVERY_FAILED' | 'CONNECTION_FAILED' | 'TIMEOUT',
  ) {
    super(message);
    this.name = 'RemoteExecutionError';
  }
}

function configureMulticast(sock: dgram.Socket, endpoint: RemoteEndpoint): void {
  sock.setMulticastTTL(1);
  sock.setMulticastLoopback(true);
  try {
    sock.addMembership(endpoint.multicastGroup, endpoint.bindAddress);
  } catch {
    // Already joined, or the interface refuses; discovery still proceeds.
  }
}

/** Decode balanced top-level JSON objects from a delimiter-free byte stream. */
class JsonStreamDecoder {
  private buffer = '';

  push(chunk: string): any[] {
    this.buffer += chunk;
    const messages: any[] = [];
    for (;;) {
      const parsed = this.takeOne();
      if (!parsed) break;
      messages.push(parsed);
    }
    return messages;
  }

  private takeOne(): any | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const ch = this.buffer[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const raw = this.buffer.slice(start, i + 1);
          this.buffer = this.buffer.slice(i + 1);
          try {
            return JSON.parse(raw);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

/**
 * A Python session against one editor instance.
 *
 * Discovery runs per instance; the TCP command channel is opened lazily so a
 * preset that never executes Python pays no connection cost.
 */
export class PythonRemoteSession {
  private readonly nodeId = randomUUID();
  private editorId: string | null = null;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private decoder = new JsonStreamDecoder();
  private pending: Array<(value: any) => void> = [];

  private readonly endpoint: RemoteEndpoint;

  constructor(endpoint: RemoteEndpoint = DEFAULT_ENDPOINT, private readonly timeoutMs = 20_000) {
    this.endpoint = endpoint;
  }

  /** Find the editor via multicast ping/pong. */
  async discover(attempts = 6, intervalMs = 600): Promise<DiscoveredEditor> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        try {
          sock.close();
        } catch {
          /* already closed */
        }
        fn();
      };

      sock.on('error', () => finish(() => reject(new RemoteExecutionError('multicast socket failed', 'DISCOVERY_FAILED'))));

      sock.on('message', (msg) => {
        if (settled) return;
        let parsed: any;
        try {
          parsed = JSON.parse(msg.toString());
        } catch {
          return;
        }
        if (parsed.type !== 'pong' || parsed.dest !== this.nodeId) return;
        this.editorId = parsed.source;
        const data = parsed.data ?? {};
        finish(() =>
          resolve({
            nodeId: parsed.source,
            projectName: data.project_name,
            projectRoot: data.project_root,
            engineVersion: data.engine_version,
          }),
        );
      });

      const ping = JSON.stringify({
        version: PROTOCOL_VERSION,
        magic: PROTOCOL_MAGIC,
        type: 'ping',
        source: this.nodeId,
      });

      let sent = 0;
      let timer: NodeJS.Timeout;
      sock.bind(this.endpoint.port, this.endpoint.bindAddress, () => {
        configureMulticast(sock, this.endpoint);
        timer = setInterval(() => {
          if (settled) return;
          sock.send(Buffer.from(ping), this.endpoint.port, this.endpoint.multicastGroup);
          sent += 1;
          if (sent >= attempts) {
            finish(() =>
              reject(
                new RemoteExecutionError(
                  'no Unreal Editor answered discovery; enable bRemoteExecution in the project config',
                  'DISCOVERY_FAILED',
                ),
              ),
            );
          }
        }, intervalMs);
      });
    });
  }

  /** Start our TCP command server and ask the editor to connect to it. */
  private async openCommandChannel(): Promise<void> {
    if (!this.editorId) throw new RemoteExecutionError('discover() must run first', 'CONNECTION_FAILED');
    if (this.socket) return;

    const server = net.createServer((socket) => {
      this.socket = socket;
      socket.on('data', (chunk) => {
        for (const message of this.decoder.push(chunk.toString())) {
          if (message.type === 'command_result' && this.pending.length) {
            this.pending.shift()!(message);
          }
        }
      });
      socket.on('error', () => {
        /* closed by peer; next run reopens */
      });
    });

    this.server = server;
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });

    await this.sendUdp({
      type: 'open_connection',
      dest: this.editorId,
      data: { command_ip: '127.0.0.1', command_port: port },
    });

    await this.waitForSocket();
  }

  private waitForSocket(): Promise<void> {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const timer = setInterval(() => {
        if (this.socket) {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new RemoteExecutionError('editor did not open the command channel', 'CONNECTION_FAILED'));
        }
      }, 100);
    });
  }

  private sendUdp(message: object): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const full = {
        version: PROTOCOL_VERSION,
        magic: PROTOCOL_MAGIC,
        source: this.nodeId,
        ...message,
      };
      sock.bind(this.endpoint.port, this.endpoint.bindAddress, () => {
        configureMulticast(sock, this.endpoint);
        sock.send(Buffer.from(JSON.stringify(full)), this.endpoint.port, this.endpoint.multicastGroup, (err) => {
          setTimeout(() => {
            try {
              sock.close();
            } catch {
              /* ignore */
            }
          }, 150);
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  /** Run Python in the editor and wait for its result. */
  async run(code: string, unattended = true): Promise<PythonRunResult> {
    await this.openCommandChannel();
    const socket = this.socket;
    if (!socket) throw new RemoteExecutionError('command channel is not open', 'CONNECTION_FAILED');

    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p !== settle);
        reject(new RemoteExecutionError('python command timed out', 'TIMEOUT'));
      }, this.timeoutMs);
      const settle = (value: any): void => {
        clearTimeout(timer);
        resolve(value);
      };
      this.pending.push(settle);
    });

    socket.write(
      Buffer.from(
        JSON.stringify({
          version: PROTOCOL_VERSION,
          magic: PROTOCOL_MAGIC,
          type: 'command',
          source: this.nodeId,
          dest: this.editorId,
          data: { command: code, unattended, exec_mode: 'ExecuteFile' },
        }),
        'utf8',
      ),
    );

    const message = await result;
    const data = message.data ?? {};
    const log = Array.isArray(data.output) ? data.output : [];
    const logText = (log as Array<{ output: string }>).map((entry) => entry.output).join('');
    // On failure the traceback arrives in `result` with an empty `output`
    // list; on success `result` holds the evaluated value. Surface whichever
    // carries text so callers never see an empty stdout for a real error.
    const value = typeof data.result === 'string' ? data.result : '';
    return {
      success: Boolean(data.success),
      stdout: data.success ? logText : logText || value,
      result: value,
      output: log,
    };
  }

  async close(): Promise<void> {
    if (this.editorId && this.socket) {
      await this.sendUdp({ type: 'close_connection', dest: this.editorId }).catch(() => undefined);
    }
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.pending = [];
  }
}


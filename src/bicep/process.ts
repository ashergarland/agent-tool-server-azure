import { spawn } from 'node:child_process';

export interface ProcessRunRequest {
  /** Absolute path of the executable. Never a shell string. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** Complete environment. The parent environment is never inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  /** Drop to this uid/gid when the process is running as root (POSIX only). */
  readonly uid?: number | undefined;
  readonly gid?: number | undefined;
}

export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Port so that compiler behaviour can be tested without a real binary or a real child process. */
export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

class BoundedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  public truncated = false;

  public constructor(private readonly limit: number) {}

  public push(chunk: Buffer): void {
    if (this.size >= this.limit) {
      this.truncated = true;
      return;
    }
    const remaining = this.limit - this.size;
    if (chunk.length > remaining) {
      this.chunks.push(chunk.subarray(0, remaining));
      this.size = this.limit;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  public toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/**
 * Runs a child process with no shell, no inherited environment, a hard wall clock limit and a hard
 * output limit. A compiler that hangs or floods stdout is killed rather than allowed to consume
 * the container.
 */
export class NodeProcessRunner implements ProcessRunner {
  public run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    return new Promise<ProcessRunResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        // Never a shell: arguments are passed as an argv array so no value can be reinterpreted
        // as a command, a redirection or a glob.
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(request.uid === undefined ? {} : { uid: request.uid }),
        ...(request.gid === undefined ? {} : { gid: request.gid }),
      });

      const stdout = new BoundedBuffer(request.maxOutputBytes);
      const stderr = new BoundedBuffer(request.maxOutputBytes);
      let timedOut = false;
      let settled = false;

      const kill = (): void => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);

      const onAbort = (): void => {
        timedOut = true;
        kill();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (result: ProcessRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk);
        if (stdout.truncated) kill();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk);
        if (stderr.truncated) kill();
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        reject(error);
      });

      child.on('close', (code) => {
        finish({
          exitCode: code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
          truncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

import { runBoundedProcess } from '@agent-tool-platform/runtime/process';

export interface ProcessRunRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ProcessRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly durationMs: number;
}

/** Port so compiler behavior can be tested without a real binary or child process. */
export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

/** Adapts the Platform bounded-process primitive to the Bicep compiler port. */
export class PlatformProcessRunner implements ProcessRunner {
  public async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const result = await runBoundedProcess({
      executablePath: request.command,
      label: 'Bicep CLI',
      args: request.args,
      cwd: request.cwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
      maxStderrBytes: request.maxOutputBytes,
      signal: request.signal,
    });
    const stderrAtLimit = Buffer.byteLength(result.stderr, 'utf8') >= request.maxOutputBytes;
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut || result.aborted,
      truncated: result.outputLimitReached || stderrAtLimit,
      durationMs: result.durationMs,
    };
  }
}

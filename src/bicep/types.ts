/**
 * Types for the Bicep compilation boundary. Everything a caller supplies is a *virtual* bundle:
 * an in-memory set of relative paths and UTF-8 contents. Nothing from the host filesystem, no
 * URLs and no shell are ever involved.
 */

export interface BicepSourceFile {
  readonly path: string;
  readonly content: string;
}

export interface BicepBundle {
  readonly mainFile: string;
  readonly files: readonly BicepSourceFile[];
}

export interface BundleLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPathLength: number;
  readonly maxDepth: number;
  readonly allowedExtensions: readonly string[];
}

export interface NormalizedBundle {
  /** POSIX-relative path of the entry template, guaranteed to be present in {@link files}. */
  readonly mainFile: string;
  readonly files: readonly BicepSourceFile[];
  readonly totalBytes: number;
  /** Stable digest of the whole bundle: identifies "the exact source" in a confirmation hash. */
  readonly sourceHash: string;
}

export type BicepDiagnosticLevel = 'error' | 'warning' | 'info';

export interface BicepDiagnostic {
  readonly level: BicepDiagnosticLevel;
  readonly code: string | undefined;
  readonly message: string;
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
}

export interface BicepCompileRequest {
  readonly bundle: NormalizedBundle;
  readonly signal?: AbortSignal | undefined;
}

export interface BicepCompileResult {
  /** Compiled ARM JSON. Only present when compilation produced no error diagnostics. */
  readonly template: Record<string, unknown> | undefined;
  readonly diagnostics: readonly BicepDiagnostic[];
  readonly durationMs: number;
  readonly truncatedOutput: boolean;
}

export interface BicepCompilerInfo {
  readonly available: boolean;
  readonly version: string | undefined;
  readonly checksumVerified: boolean;
  readonly detail: string | undefined;
}

/** Port. Tests substitute this; the CLI adapter is the only real implementation. */
export interface BicepCompiler {
  compile(request: BicepCompileRequest): Promise<BicepCompileResult>;
  /** Cheap readiness probe. Must never throw. */
  describe(): Promise<BicepCompilerInfo>;
}

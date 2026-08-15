import { describe, expect, it } from 'vitest';
import { NodeProcessRunner } from '../../src/bicep/process.js';

const runner = new NodeProcessRunner();

const runNode = (script: string, overrides: Partial<Parameters<typeof runner.run>[0]> = {}) =>
  runner.run({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: {
      PATH: '',
      ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}),
    },
    timeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    ...overrides,
  });

describe('NodeProcessRunner', () => {
  it('runs a command with an argv array and captures both streams', async () => {
    const result = await runNode('process.stdout.write("out");process.stderr.write("err")');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('reports a non-zero exit code rather than throwing', async () => {
    const result = await runNode('process.exit(3)');
    expect(result.exitCode).toBe(3);
  });

  it('never interprets arguments as shell syntax', async () => {
    // With a shell this would create a file; without one it is just a string argument.
    const result = await runNode('process.stdout.write(process.argv[1] ?? "")', {
      args: ['-e', 'process.stdout.write(process.argv[1] ?? "")', '> /tmp/pwned; echo hi'],
    });
    expect(result.stdout).toBe('> /tmp/pwned; echo hi');
  });

  it('passes only the environment it was given', async () => {
    process.env['ATSA_LEAK_CANARY'] = 'super-secret';
    try {
      const result = await runNode(
        'process.stdout.write(JSON.stringify(Object.keys(process.env)))',
      );
      expect(result.stdout).not.toContain('ATSA_LEAK_CANARY');
    } finally {
      delete process.env['ATSA_LEAK_CANARY'];
    }
  });

  it('kills a process that outlives its timeout', async () => {
    const result = await runNode('setTimeout(() => {}, 60000)', { timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it('truncates and kills a process that floods stdout', async () => {
    const result = await runNode(
      'for (let i = 0; i < 1e6; i += 1) process.stdout.write("x".repeat(1000))',
      { maxOutputBytes: 4096, timeoutMs: 10_000 },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });

  it('kills the process when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = runNode('setTimeout(() => {}, 60000)', { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.timedOut).toBe(true);
  });

  it('rejects when the executable does not exist', async () => {
    await expect(
      runner.run({
        command: '/definitely/not/a/real/binary',
        args: [],
        cwd: process.cwd(),
        env: {},
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow();
  });
});

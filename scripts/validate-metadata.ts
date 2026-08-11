import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const projectName = 'agent-tool-server-azure';
const repositoryUrl = `https://github.com/ashergarland/${projectName}`;

const repositorySchema = z.object({
  url: z.literal(repositoryUrl),
  source: z.literal('github'),
});

const serverSchema = z
  .object({
    $schema: z.literal(
      'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    ),
    name: z.literal(`io.github.ashergarland/${projectName}`),
    title: z.string().min(1).max(100),
    description: z.string().min(1).max(100),
    websiteUrl: z.literal(repositoryUrl),
    repository: repositorySchema,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    packages: z.never().optional(),
    remotes: z.never().optional(),
  })
  .strict();

const packageSchema = z
  .object({
    name: z.literal(projectName),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    repository: z.object({
      type: z.literal('git'),
      url: z.literal(`git+${repositoryUrl}.git`),
    }),
    bin: z
      .record(z.string(), z.string())
      .refine(
        (bin) => bin[`${projectName}-mcp`] === 'dist/mcp/stdio.js',
        `bin must expose ${projectName}-mcp`,
      ),
  })
  .passthrough();

const loadJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const server = serverSchema.parse(await loadJson('server.json'));
const packageMetadata = packageSchema.parse(await loadJson('package.json'));

if (server.version !== packageMetadata.version) {
  throw new Error(
    `server.json version ${server.version} does not match package.json ${packageMetadata.version}`,
  );
}

process.stdout.write('Server and package metadata are consistent.\n');

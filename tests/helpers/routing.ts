import type { RegisteredTool } from '../../src/tools/registry.js';

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'i',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'not',
  'of',
  'on',
  'or',
  'that',
  'the',
  'then',
  'this',
  'to',
  'up',
  'want',
  'was',
  'we',
  'what',
  'when',
  'which',
  'with',
  'you',
  'your',
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));

const countMatches = (haystack: string, tokens: readonly string[]): number => {
  const words = new Set(tokenize(haystack));
  return tokens.filter((token) => words.has(token)).length;
};

export interface RoutingScore {
  readonly name: string;
  readonly score: number;
}

/**
 * A deliberately crude lexical router.
 *
 * It is not a model, and it is not trying to be. Its purpose is to fail whenever a tool's
 * `useWhen`, title and summary stop containing the vocabulary a user would actually use for that
 * task, or when a sibling tool's `doNotUseWhen` stops steering away from it. That is exactly the
 * property that makes descriptions useful to a real model, and it is checkable without one.
 */
export const scoreTools = (query: string, tools: readonly RegisteredTool[]): RoutingScore[] => {
  const tokens = tokenize(query);

  return tools
    .map((tool) => {
      const useWhen = countMatches(tool.routing.useWhen.join(' '), tokens) * 3;
      const headline = countMatches(`${tool.title} ${tool.summary}`, tokens) * 2;
      const body = countMatches(tool.baseDescription, tokens);
      const steerAway = countMatches(tool.routing.doNotUseWhen.join(' '), tokens) * 2;
      return { name: tool.name, score: useWhen + headline + body - steerAway };
    })
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
};

export const topTool = (query: string, tools: readonly RegisteredTool[]): string =>
  scoreTools(query, tools)[0]?.name ?? '';

export const rankOf = (name: string, query: string, tools: readonly RegisteredTool[]): number =>
  scoreTools(query, tools).findIndex((entry) => entry.name === name);

/**
 * Repository hygiene checks shared by the OpenAPI checker and the metadata tests.
 *
 * The thing being prevented is a published artefact — an OpenAPI document, `server.json`, a
 * parameter file — carrying the hostname of whoever happened to emit it. This project is meant to
 * be forked and deployed by anyone, so an account-specific host in a committed file is a defect.
 */

/** Azure domains whose hostnames only ever exist inside one person's subscription. */
export const DEPLOYMENT_SPECIFIC_SUFFIXES = [
  'azurecr.io',
  'azurewebsites.net',
  'azurecontainerapps.io',
  'blob.core.windows.net',
  'table.core.windows.net',
  'queue.core.windows.net',
  'vault.azure.net',
] as const;

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches a *complete* hostname under one of those domains.
 *
 * Both ends are anchored to a hostname boundary rather than left as a bare substring search. A
 * substring would match `notazurecr.io` and `example.com/azurecr.io`, which are not hosts in those
 * domains at all — reporting them would be wrong, and relying on a substring to decide anything
 * about a URL is the mistake CodeQL's `js/incomplete-url-substring-sanitization` describes.
 */
const HOSTNAME = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9.-])((?:[A-Za-z0-9-]+\.)+(?:${DEPLOYMENT_SPECIFIC_SUFFIXES.map(escape).join('|')}))(?![A-Za-z0-9.-])`,
  'gi',
);

/** Every deployment-specific hostname appearing in arbitrary text, deduplicated. */
export const findDeploymentSpecificHosts = (text: string): string[] => {
  const found = new Set<string>();
  for (const match of text.matchAll(HOSTNAME)) {
    const host = match[1];
    if (host) found.add(host.toLowerCase());
  }
  return [...found].sort();
};

/**
 * True when a URL points at a deployment-specific host.
 *
 * The URL is parsed and only its hostname is compared, so a path, query or userinfo component
 * cannot make an unrelated URL look like one of these hosts, and a longer hostname that merely ends
 * in the same characters cannot masquerade as one.
 */
export const isDeploymentSpecificUrl = (candidate: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname.toLowerCase();
  } catch {
    return false;
  }
  return DEPLOYMENT_SPECIFIC_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
};

/** A GUID here would be somebody's tenant, subscription, client or principal id. */
export const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

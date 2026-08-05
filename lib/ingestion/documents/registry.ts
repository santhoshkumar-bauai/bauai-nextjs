import { cosinexResolver } from "./resolvers/cosinex.ts";
import { directFileResolver } from "./resolvers/direct-file.ts";
import { evergabeOnlineResolver } from "./resolvers/evergabe-online.ts";
import type { DocumentResolver } from "./types.ts";

/**
 * Host → platform resolver.
 *
 * Registered per **platform family**, not per host. Seven of the busiest German hosts
 * (`vergabemarktplatz.brandenburg.de`, `vergabe.niedersachsen.de`,
 * `sachsen-vergabe.de`, `vergabe-westfalen.de`, `vergabe.landbw.de`,
 * `vmp-rheinland.de`, `vergabe.metropoleruhr.de`) run the same software, so one
 * resolver covers them all. Adding a state portal is usually a one-line host entry.
 */
const resolvers: DocumentResolver[] = [
  cosinexResolver,
  evergabeOnlineResolver,
  // Platform resolvers are appended here as each family is implemented.
];

export function resolverFor(url: URL): DocumentResolver {
  for (const resolver of resolvers) {
    if (resolver.matches(url)) return resolver;
  }
  return directFileResolver;
}

/** True when a real platform resolver exists, as opposed to the generic fallback. */
export function hasPlatformResolver(url: URL): boolean {
  return resolvers.some((resolver) => resolver.matches(url));
}

export function registerResolver(resolver: DocumentResolver): void {
  resolvers.push(resolver);
}

export function registeredPlatforms(): string[] {
  return [...new Set(resolvers.map((resolver) => resolver.platform))];
}

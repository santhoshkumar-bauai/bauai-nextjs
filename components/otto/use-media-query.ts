"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a media query.
 *
 * `useSyncExternalStore` rather than state-in-an-effect: it is the API built
 * for reading a value that lives outside React, and its server snapshot is
 * what keeps hydration from disagreeing about a value the server cannot know.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    // The server has no viewport; assume narrow so nothing desktop-only is
    // rendered into HTML that a phone would then have to undo.
    () => false,
  );
}

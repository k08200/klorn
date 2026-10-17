"use client";

import { useEffect, useState } from "react";

/**
 * Whether a media query matches, following changes. False until mounted, so
 * the server render and the first client render agree (the narrow layout).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

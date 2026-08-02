/**
 * Defensive copies at every external read (state_and_lifecycle.md)
 * Readers don't coordinate with writers.
 */
export function deepCopy<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  // Use structuredClone for modern node (available in recent)
  try {
    return structuredClone(obj);
  } catch {
    // fallback for older or circular (we avoid circular)
    return JSON.parse(JSON.stringify(obj));
  }
}

export function shallowCopyArray<T>(arr: T[]): T[] {
  return [...arr];
}

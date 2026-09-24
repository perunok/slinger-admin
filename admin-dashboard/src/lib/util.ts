/** Returns a function that delays `fn` until `ms` after the last call. */
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

export const matches = (needle: string, ...haystack: (string | null | undefined)[]) => {
  const n = needle.trim().toLowerCase();
  return n === '' || haystack.some((h) => h?.toLowerCase().includes(n));
};

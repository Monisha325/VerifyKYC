/**
 * Minimal type declarations for the `fuzzball` fuzzy-string-matching library.
 * Only the functions used in identity correlation are declared here.
 */
declare module 'fuzzball' {
  interface Options {
    scorer?: (...args: unknown[]) => number;
    processor?: (s: string) => string;
    full_process?: boolean;
    force_ascii?: boolean;
    useCollator?: boolean;
  }

  /** Token-sort then Levenshtein ratio — good for name fields. Returns 0..100. */
  export function token_sort_ratio(s1: string, s2: string, options?: Options): number;

  /** Token-set ratio — handles extra tokens gracefully. Returns 0..100. */
  export function token_set_ratio(s1: string, s2: string, options?: Options): number;

  /** Simple ratio (no tokenisation). Returns 0..100. */
  export function ratio(s1: string, s2: string, options?: Options): number;

  /** Pre-process a string (lowercase, trim, collapse whitespace). */
  export function full_process(s: string, forceAscii?: boolean): string;
}

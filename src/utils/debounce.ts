/**
 * @module
 * @description Utility for debouncing function calls.
 */

/**
 * Debounces a function, ensuring it's only called after a specified delay since the last invocation.
 *
 * @template Args - The argument tuple accepted by the function.
 * @param func - The function to debounce.
 * @param {number} delay - The delay in milliseconds before the function is invoked.
 * @returns The debounced function with a method for cancelling a pending invocation.
 */
type DebouncedFunction<Args extends unknown[]> = ((...args: Args) => void) & { cancel(): void };

export function debounce<Args extends unknown[]>(
  func: (...args: Args) => unknown,
  delay: number
): DebouncedFunction<Args> {
  let timeout: NodeJS.Timeout | undefined;

  const debounced = function (this: ThisParameterType<typeof func>, ...args: Args): void {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = undefined;
      func.apply(this, args);
    }, delay);
  } as DebouncedFunction<Args>;

  debounced.cancel = (): void => {
    clearTimeout(timeout);
    timeout = undefined;
  };

  return debounced;
}

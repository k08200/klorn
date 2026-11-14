/**
 * Wrap a Prisma-shaped client so every model call is recorded as
 * "model.method" — for tests that pin how many queries a read makes (no N+1).
 */

type AnyFn = (...args: unknown[]) => unknown;

export function countingClient<T extends object>(client: T, log: string[]): T {
  return new Proxy(client, {
    get(target, model, receiver) {
      const delegate = Reflect.get(target, model, receiver);
      if (typeof model !== "string" || model.startsWith("$")) return delegate;
      if (typeof delegate !== "object" || delegate === null) return delegate;
      return new Proxy(delegate as object, {
        get(inner, method, innerReceiver) {
          const fn = Reflect.get(inner, method, innerReceiver);
          if (typeof fn !== "function" || typeof method !== "string") return fn;
          return (...args: unknown[]) => {
            log.push(`${model}.${method}`);
            return (fn as AnyFn).apply(inner, args);
          };
        },
      });
    },
  });
}

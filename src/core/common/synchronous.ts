export type SynchronousResult<T> = T &
    (Extract<T, PromiseLike<unknown>> extends never ? unknown : never);

export function assertSynchronousResult(value: unknown, operation: string): void {
    if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof (Reflect.get(value, "then") as unknown) === "function"
    ) {
        throw new TypeError(`${operation} must complete synchronously`);
    }
}

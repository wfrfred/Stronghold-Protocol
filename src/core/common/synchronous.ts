export type SynchronousResult<T> = T &
    (T extends ReturnType<() => void> ? undefined : unknown) &
    (Extract<T, PromiseLike<unknown>> extends never ? unknown : never);

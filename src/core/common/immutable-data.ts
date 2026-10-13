export type ImmutableData<T> = T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: ImmutableData<T[K]> }
      : T;

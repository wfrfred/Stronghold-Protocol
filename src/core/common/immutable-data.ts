export type ImmutableData<T> = T extends object
    ? { readonly [K in keyof T]: ImmutableData<T[K]> }
    : T;

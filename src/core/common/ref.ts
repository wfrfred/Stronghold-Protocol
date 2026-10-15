declare const identity: unique symbol;
declare const referent: unique symbol;

export interface Identified<out I extends object> {
    readonly [identity]?: I;
}

export type Identity<T> = T extends Identified<infer I> ? I : never;

export interface Phantom<out T> {
    readonly [referent]: T;
}

export type Ref<T> = Identity<T> & Phantom<T>;

import type { Contribution } from "../../contribution/contribution.js";
import type { Input } from "./input.js";

export type Definition =
    | { readonly type: "TIME"; readonly durationTicks: number }
    | { readonly type: "AMMO"; readonly amount: number }
    | { readonly type: "INFINITE" };

export interface Ammo {
    readonly type: "AMMO";
    readonly initial: number;
    readonly remaining: number;
    readonly replenished: number;
}

export type State =
    { readonly type: "TIME"; readonly endsAtTick: number } | Ammo | { readonly type: "INFINITE" };

export type Contributions<S extends object, A extends object> =
    | { readonly type: "TIME"; readonly duration: readonly Contribution<Input<S, A>>[] }
    | { readonly type: "AMMO"; readonly ammo: readonly Contribution<Input<S, A>>[] }
    | { readonly type: "INFINITE" };

export function initialize<S extends object, A extends object>(
    definition: Definition,
): Contributions<S, A> {
    switch (definition.type) {
        case "TIME":
            return { type: "TIME", duration: [] };

        case "AMMO":
            return { type: "AMMO", ammo: [] };

        case "INFINITE":
            return { type: "INFINITE" };
    }
}

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

export type Contributions =
    | { readonly type: "TIME"; readonly duration: readonly Contribution<Input>[] }
    | { readonly type: "AMMO"; readonly ammo: readonly Contribution<Input>[] }
    | { readonly type: "INFINITE" };

export function initialize(definition: Definition): Contributions {
    switch (definition.type) {
        case "TIME":
            return { type: "TIME", duration: [] };

        case "AMMO":
            return { type: "AMMO", ammo: [] };

        case "INFINITE":
            return { type: "INFINITE" };
    }
}

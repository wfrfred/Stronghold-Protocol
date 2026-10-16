import type { Identified, Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import type { Skill } from "./capability.js";
import type { Instance } from "./instance.js";
import type { Operation } from "./rule.js";
import type { Definition as SustainDefinition, State as SustainState } from "./sustain.js";

export type Trigger = "MANUAL" | "AUTO" | "PASSIVE";

export type End =
    { readonly type: "FINISHED" } | { readonly type: "CANCELLED"; readonly reason: string };

export interface Definition<S extends object, A extends object> {
    readonly trigger: Trigger;
    readonly sustain: SustainDefinition;
    readonly initialize: (battle: BattleState, self: Instance<S, A>) => A;
    readonly accepts?: (battle: BattleState, self: Instance<S, A>) => boolean;
    readonly cost?: (battle: BattleState, self: Instance<S, A>) => number;
    readonly onStart?: (battle: BattleState, self: Activation<A>) => BattleState;
    readonly onTick?: (battle: BattleState, self: Activation<A>) => BattleState;
    readonly onOperation?: (
        battle: BattleState,
        self: Activation<A>,
        operation: Operation,
    ) => BattleState;
    readonly onEnd?: (battle: BattleState, self: Activation<A>, end: End) => BattleState;
}

export interface Activation<A extends object = object> extends Identified<{
    readonly host: Ref<Unit & Skill>;
    readonly id: number;
}> {
    readonly host: Ref<Unit & Skill>;
    readonly id: number;
    readonly startedAtTick: number;
    readonly status: "ACTIVE" | "ENDING";
    readonly sustain: SustainState;
    readonly data: A;
}

export function ref<T extends Activation>(self: T): Ref<T> {
    return { host: self.host, id: self.id } as Ref<T>;
}

export function setData<A extends object>(
    self: Activation<A>,
    next: NoInfer<A> | ((current: NoInfer<A>) => NoInfer<A>),
): Activation<A> {
    const data = typeof next === "function" ? next(self.data) : next;

    return data === self.data ? self : { ...self, data };
}

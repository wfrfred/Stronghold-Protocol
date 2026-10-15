import type { Identified, Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import type { Skill, Stored as StoredSkill } from "./capability.js";
import type { Operation } from "./rule.js";
import type { Definition as SustainDefinition, State as SustainState } from "./sustain.js";

export type Trigger = "MANUAL" | "AUTO" | "PASSIVE";

export type End =
    { readonly type: "FINISHED" } | { readonly type: "CANCELLED"; readonly reason: string };

export interface Definition<S extends object, A extends object> {
    readonly trigger: Trigger;
    readonly sustain: SustainDefinition;
    readonly initialize: (battle: BattleState, self: Unit & Skill<S, A>) => A;
    readonly accepts?: (battle: BattleState, self: Unit & Skill<S, A>) => boolean;
    readonly cost?: (battle: BattleState, self: Unit & Skill<S, A>) => number;
    readonly onStart?: (battle: BattleState, self: Activation<S, A>) => BattleState;
    readonly onTick?: (battle: BattleState, self: Activation<S, A>) => BattleState;
    readonly onOperation?: (
        battle: BattleState,
        self: Activation<S, A>,
        operation: Operation,
    ) => BattleState;
    readonly onEnd?: (battle: BattleState, self: Activation<S, A>, end: End) => BattleState;
}

export interface Activation<
    S extends object = object,
    A extends object = object,
> extends Identified<{
    readonly host: Ref<Unit & Skill<S, A>>;
    readonly id: number;
}> {
    readonly host: Ref<Unit & Skill<S, A>>;
    readonly id: number;
    readonly startedAtTick: number;
    readonly status: "ACTIVE" | "ENDING";
    readonly sustain: SustainState;
    readonly data: A;
}

export interface Stored extends Identified<{
    readonly host: Ref<Unit & StoredSkill>;
    readonly id: number;
}> {
    readonly host: Ref<Unit & StoredSkill>;
    readonly id: number;
    readonly startedAtTick: number;
    readonly status: "ACTIVE" | "ENDING";
    readonly sustain: SustainState;
    readonly data: object;
}

export function ref<T extends Stored>(self: T): Ref<T> {
    return { host: self.host, id: self.id } as Ref<T>;
}

export function setData<S extends object, A extends object>(
    self: Activation<S, A>,
    next: NoInfer<A> | ((current: NoInfer<A>) => NoInfer<A>),
): Activation<S, A> {
    const data = typeof next === "function" ? next(self.data) : next;

    return data === self.data ? self : { ...self, data };
}

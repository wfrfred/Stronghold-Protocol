import type { Identified, Ref } from "../../../common/ref.js";
import type { Unit } from "../unit.js";
import type { Action as ActionCapability } from "../capability/action/capability.js";
import type { Definition } from "./definition.js";
import type { Actions } from "./actions.js";

export type Id = number;

export type Status = "RUNNING" | "ENDING";

type StoredAction = ReturnType<Actions["values"]>[number];

export interface Action<S extends object = object> extends Identified<{ readonly id: Id }> {
    readonly id: Id;
    readonly source: Ref<Unit & ActionCapability>;
    readonly definition: Definition<S>;
    readonly startedAtTick: number;
    readonly status: Status;
    readonly state: S;
}

export function ref<A extends StoredAction>(action: A): Ref<A> {
    return { id: action.id } as Ref<A>;
}

export function setState<S extends object>(
    self: Action<S>,
    next: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
): Action<S> {
    const state = typeof next === "function" ? next(self.state) : next;

    return state === self.state ? self : { ...self, state };
}

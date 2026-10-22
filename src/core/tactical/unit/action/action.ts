import type { Identified, Ref } from "../../../common/ref.js";
import type { Unit } from "../unit.js";
import type { Action as ActionCapability } from "../capability/action/capability.js";
import type { Definition, View as DefinitionView } from "./definition.js";

export type Id = number;

export type Status = "RUNNING" | "ENDING";

export interface View extends Identified<{
    readonly host: Ref<Unit & ActionCapability>;
    readonly id: Id;
}> {
    readonly id: Id;
    readonly host: Ref<Unit & ActionCapability>;
    readonly definition: DefinitionView;
    readonly startedAtTick: number;
    readonly status: Status;
}

export interface Action<P extends object = object, E extends object = object> extends View {
    readonly definition: Definition<P, E>;
    readonly state: E;
}

export interface Snapshot extends View {
    readonly state: unknown;
}

export function ref<A extends View>(action: A): Ref<A> {
    return { host: action.host, id: action.id } as Ref<A>;
}

export function setState<P extends object, E extends object>(
    self: Action<P, E>,
    next: NoInfer<E> | ((current: NoInfer<E>) => NoInfer<E>),
): Action<P, E> {
    const state = typeof next === "function" ? next(self.state) : next;

    return state === self.state ? self : { ...self, state };
}

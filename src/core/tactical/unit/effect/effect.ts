import type { UnitId } from "../unit.js";
import type { ActionExecutionId } from "../capability/action/process.js";
import type { Definition } from "./definition.js";

export type Id = number;

export type Lifetime =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | { readonly type: "ACTION"; readonly executionId: ActionExecutionId }
    | { readonly type: "SKILL"; readonly unitId: UnitId; readonly activationId: number }
    | { readonly type: "EFFECT"; readonly unitId: UnitId; readonly effectId: Id };

export type Ref = Extract<Lifetime, { type: "EFFECT" }>;

export type Scope = Lifetime | { readonly type: "TICK"; readonly tick: number };

export type Status = "ACTIVE" | "INACTIVE" | "FINISHED";

export interface Group {
    readonly id: string;
    readonly priority: number;
}

export interface Value {
    readonly id: Id;
    readonly definition: { readonly id: string };
    readonly state: object;
    readonly source: UnitId | null;
    readonly scopes: readonly Scope[];
    readonly group?: Group;
    readonly enabled: boolean;
    readonly status: Status;
}

export interface Effect<S extends object, H extends object = object> extends Value {
    readonly definition: Definition<S, H>;
    readonly state: S;
}

export interface State {
    readonly instances: readonly Value[];
    readonly nextId: Id;
}

export function key(scope: Scope): string {
    switch (scope.type) {
        case "UNIT":
            return `UNIT:${scope.unitId}`;

        case "ACTION":
            return `ACTION:${scope.executionId}`;

        case "SKILL":
            return `SKILL:${scope.unitId}:${scope.activationId}`;

        case "EFFECT":
            return `EFFECT:${scope.unitId}:${scope.effectId}`;

        case "TICK":
            return `TICK:${scope.tick}`;
    }
}

export function deadline(instance: Value): number | null {
    const ticks = instance.scopes.flatMap((scope) => (scope.type === "TICK" ? [scope.tick] : []));

    return ticks.length === 0 ? null : Math.min(...ticks);
}

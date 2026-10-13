import type { Id as UnitId } from "../unit.js";
import type { ActionExecutionId } from "../capability/action/process.js";
import type { Definition } from "./definition.js";
import { assertNonnegativeSafeInteger } from "../../../common/assert.js";

export type Id = number;

export type Lifetime =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | { readonly type: "ACTION"; readonly executionId: ActionExecutionId }
    | { readonly type: "SKILL"; readonly unitId: UnitId; readonly activationId: number }
    | { readonly type: "EFFECT"; readonly unitId: UnitId; readonly effectId: Id };

export type Ref = Extract<Lifetime, { type: "EFFECT" }>;

export type Scope = Lifetime | { readonly type: "TICK"; readonly tick: number };

export type Status = "INSTALLING" | "INACTIVE" | "ACTIVE" | "ENDING";

export interface Effect<S extends object = object, H extends object = object> {
    readonly id: Id;
    readonly definition: Definition<S, H>;
    readonly data: S;
    readonly source: UnitId | null;
    readonly scopes: readonly Scope[];
    readonly enabled: boolean;
    readonly status: Status;
}

export function setData<S extends object, H extends object>(
    effect: Effect<S, H>,
    next: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
): Effect<S, H> {
    const data = typeof next === "function" ? next(effect.data) : next;

    return data === effect.data ? effect : { ...effect, data };
}

export function setDeadline<S extends object, H extends object>(
    effect: Effect<S, H>,
    tick: number | null,
): Effect<S, H> {
    if (tick !== null) {
        assertNonnegativeSafeInteger(tick, "effect deadline");
    }

    const deadlines = effect.scopes.filter((scope) => scope.type === "TICK");

    if (
        (tick === null && deadlines.length === 0) ||
        (deadlines.length === 1 && deadlines[0]!.tick === tick)
    ) {
        return effect;
    }

    return {
        ...effect,
        scopes: [
            ...effect.scopes.filter((scope) => scope.type !== "TICK"),
            ...(tick === null ? [] : [{ type: "TICK" as const, tick }]),
        ],
    };
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

export function deadline(instance: { readonly scopes: readonly Scope[] }): number | null {
    const ticks = instance.scopes.flatMap((scope) => (scope.type === "TICK" ? [scope.tick] : []));

    return ticks.length === 0 ? null : Math.min(...ticks);
}

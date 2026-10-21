import type { Id as UnitId, Unit } from "../unit.js";
import type { Actions } from "../action/actions.js";
import type { Burst } from "../capability/elemental/burst.js";
import type { Activation as SkillActivation } from "../capability/skill/activation.js";
import type { Definition } from "./definition.js";
import type { Effects } from "./effects.js";
import type { Identified, Ref } from "../../../common/ref.js";
import { assertNonnegativeSafeInteger } from "../../../common/assert.js";

export type Id = number;

export type Lifetime =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | { readonly type: "ACTION"; readonly ref: Ref<ReturnType<Actions["values"]>[number]> }
    | { readonly type: "SKILL"; readonly ref: Ref<SkillActivation> }
    | { readonly type: "ELEMENTAL_BURST"; readonly ref: Ref<Burst> }
    | { readonly type: "EFFECT"; readonly ref: Ref<StoredEffect> };

export type Scope = Lifetime | { readonly type: "TICK"; readonly tick: number };

export type Status = "INSTALLING" | "INACTIVE" | "ACTIVE" | "ENDING";

type StoredEffect = ReturnType<Effects["values"]>[number];

export interface Effect<S extends object = object, H extends object = object> extends Identified<{
    readonly host: Ref<Unit & H>;
    readonly id: Id;
}> {
    readonly id: Id;
    readonly host: Ref<Unit & H>;
    readonly definition: Definition<S, H>;
    readonly data: S;
    readonly source: UnitId | null;
    readonly scopes: readonly Scope[];
    readonly enabled: boolean;
    readonly status: Status;
}

export function ref<E extends StoredEffect>(effect: E): Ref<E> {
    return { host: effect.host, id: effect.id } as Ref<E>;
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
            return `ACTION:${scope.ref.host.id}:${scope.ref.id}`;

        case "SKILL":
            return `SKILL:${scope.ref.host.id}:${scope.ref.id}`;

        case "ELEMENTAL_BURST":
            return `ELEMENTAL_BURST:${scope.ref.host.id}:${scope.ref.id}`;

        case "EFFECT":
            return `EFFECT:${scope.ref.host.id}:${scope.ref.id}`;

        case "TICK":
            return `TICK:${scope.tick}`;
    }
}

export function deadline(instance: { readonly scopes: readonly Scope[] }): number | null {
    const ticks = instance.scopes.flatMap((scope) => (scope.type === "TICK" ? [scope.tick] : []));

    return ticks.length === 0 ? null : Math.min(...ticks);
}

import type { Id as UnitId, Unit } from "../unit.js";
import type { View as ActionView } from "../action/action.js";
import type { Burst } from "../capability/elemental/burst.js";
import type { Activation as SkillActivation } from "../capability/skill/activation.js";
import type { Definition } from "./definition.js";
import type { Identified, Ref } from "../../../common/ref.js";
import { assertNonnegativeSafeInteger } from "../../../common/assert.js";

export type Id = number;

export type Lifetime =
    | { readonly type: "UNIT"; readonly ref: Ref<Unit> }
    | { readonly type: "ACTION"; readonly ref: Ref<ActionView> }
    | { readonly type: "SKILL"; readonly ref: Ref<SkillActivation> }
    | { readonly type: "ELEMENTAL_BURST"; readonly ref: Ref<Burst> }
    | { readonly type: "EFFECT"; readonly ref: Ref<View> };

export type Scope = Lifetime | { readonly type: "TICK"; readonly tick: number };

export type Status = "INSTALLING" | "INACTIVE" | "ACTIVE" | "ENDING";

export interface View<H extends object = object> extends Identified<{
    readonly host: Ref<Unit & H>;
    readonly id: Id;
}> {
    readonly id: Id;
    readonly host: Ref<Unit & H>;
    readonly definition: Pick<Definition<object>, "id" | "group">;
    readonly source: UnitId | null;
    readonly scopes: readonly Scope[];
    readonly enabled: boolean;
    readonly status: Status;
}

export interface Effect<S extends object = object, H extends object = object> extends View<H> {
    readonly definition: Definition<S, H>;
    readonly data: S;
}

export interface Snapshot extends View {
    readonly data: unknown;
}

export function ref<E extends View>(effect: E): Ref<E> {
    return { host: effect.host, id: effect.id } as Ref<E>;
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
            return `UNIT:${scope.ref.id}`;

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

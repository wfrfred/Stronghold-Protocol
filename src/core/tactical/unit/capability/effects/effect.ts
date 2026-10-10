import type { EffectDefinitionRef } from "./definition.js";
import type { UnitId } from "../../unit.js";
import type { ActionExecutionId } from "../action/process.js";

export type EffectId = number;

export type LifetimeRef =
    | { readonly type: "UNIT"; readonly unitId: UnitId }
    | { readonly type: "ACTION"; readonly executionId: ActionExecutionId }
    | { readonly type: "SKILL"; readonly unitId: UnitId; readonly activationId: number }
    | { readonly type: "EFFECT"; readonly unitId: UnitId; readonly effectId: EffectId };

export type EffectRef = Extract<LifetimeRef, { type: "EFFECT" }>;

export type Scope = LifetimeRef | { readonly type: "TICK"; readonly tick: number };

export function lifetimeKey(ref: Scope): string {
    switch (ref.type) {
        case "UNIT":
            return `UNIT:${ref.unitId}`;

        case "ACTION":
            return `ACTION:${ref.executionId}`;

        case "SKILL":
            return `SKILL:${ref.unitId}:${ref.activationId}`;

        case "EFFECT":
            return `EFFECT:${ref.unitId}:${ref.effectId}`;

        case "TICK":
            return `TICK:${ref.tick}`;
    }
}

export const refKey = lifetimeKey;

export function sameLifetime(left: Scope, right: Scope): boolean {
    return lifetimeKey(left) === lifetimeKey(right);
}

export function effectTick(instance: EffectValue): number | null {
    const scope = instance.scopes.find((scope) => scope.type === "TICK");

    return scope?.type === "TICK" ? scope.tick : null;
}

export interface EffectLifecycleFacts {
    readonly started: boolean;
    readonly enabled: boolean;
    readonly participating: boolean;
    readonly finished: boolean;
}

export interface EffectMetadata {
    readonly id: EffectId;
    readonly source: UnitId | null;
    readonly scopes: readonly Scope[];
    readonly acquiredSequence: number;
}

export interface EffectValue extends EffectMetadata, EffectLifecycleFacts {
    readonly definitionRef: { readonly id: string };
    readonly state: object;
}

export interface Effect<S extends object> extends EffectValue {
    readonly definitionRef: EffectDefinitionRef<S>;
    readonly state: S;
}

export interface EffectSnapshot<S extends object> extends EffectMetadata, EffectLifecycleFacts {
    readonly state: S;
}

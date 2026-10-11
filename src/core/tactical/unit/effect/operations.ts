import {
    battlefieldView,
    getUnit,
    transitionUnit,
    updateUnit,
    type BattleState,
} from "../../battle/execution/context.js";
import type { Unit, UnitId } from "../unit.js";
import type { Definition } from "./definition.js";
import {
    deadline,
    key,
    type Effect,
    type Group,
    type Lifetime,
    type Ref,
    type Scope,
    type Value,
} from "./effect.js";
import { invoke } from "./internal/invoke.js";
import { dependents } from "./lifetime-index.js";
import { get } from "./query.js";
import * as state from "./state.js";

export interface Input<S extends object> {
    readonly source?: UnitId | null;
    readonly scopes?: readonly Scope[];
    readonly initialState?: S;
    readonly group?: Group;
    readonly enabled?: boolean;
}

function available(battle: BattleState, lifetime: Lifetime): boolean {
    if (battle.closedLifetimes.has(key(lifetime))) {
        return false;
    }

    switch (lifetime.type) {
        case "UNIT":
            return getUnit(battle, lifetime.unitId) !== undefined;

        case "ACTION":
            return battle.actionExecutions?.get(lifetime.executionId) !== undefined;

        case "SKILL":
            return getUnit(battle, lifetime.unitId)?.skill?.active?.id === lifetime.activationId;

        case "EFFECT": {
            const instance = get(battle, lifetime);

            return instance !== undefined && instance.status !== "FINISHED";
        }
    }
}

function change(battle: BattleState, ref: Ref, next: (instance: Value) => Value): void {
    const current = get(battle, ref);

    if (current !== undefined) {
        transitionUnit(battle, ref.unitId, (unit) => state.replace(unit, next(current)));
    }
}

function selected(instances: readonly Value[], instance: Value): boolean {
    if (!instance.enabled || instance.status === "FINISHED") {
        return false;
    }

    const group = instance.group;

    return (
        group === undefined ||
        !instances.some(
            (other) =>
                other.status !== "FINISHED" &&
                other.group?.id === group.id &&
                (other.group.priority > group.priority ||
                    (other.group.priority === group.priority && other.id < instance.id)),
        )
    );
}

function reconcile(battle: BattleState, unitId: UnitId): void {
    const refs = (getUnit(battle, unitId)?.effects.instances ?? []).map((instance): Ref => ({
        type: "EFFECT",
        unitId,
        effectId: instance.id,
    }));

    for (const ref of refs) {
        const unit = getUnit(battle, unitId);
        const current = get(battle, ref);

        if (current?.status === "ACTIVE" && !selected(unit!.effects.instances, current)) {
            change(battle, ref, (instance) => ({ ...instance, status: "INACTIVE" }));
            invoke(battle, ref, get(battle, ref)!, "onDisable");
        }
    }

    for (const ref of refs) {
        const unit = getUnit(battle, unitId);
        const current = get(battle, ref);

        if (current?.status === "INACTIVE" && selected(unit!.effects.instances, current)) {
            change(battle, ref, (instance) => ({ ...instance, status: "ACTIVE" }));
            invoke(battle, ref, get(battle, ref)!, "onEnable");
        }
    }
}

export function apply<S extends object, H extends object>(
    battle: BattleState,
    host: Unit & NoInfer<H>,
    definition: Definition<S, H>,
    input: Input<NoInfer<S>> = {},
): Ref | undefined {
    const unit = getUnit(battle, host.id);
    const scopes = input.scopes ?? [];

    if (
        unit === undefined ||
        !available(battle, { type: "UNIT", unitId: host.id }) ||
        scopes.some((scope) => scope.type !== "TICK" && !available(battle, scope))
    ) {
        return undefined;
    }

    const instance: Effect<S, H> = {
        id: unit.effects.nextId,
        definition,
        state: input.initialState ?? definition.initialize(),
        source: input.source ?? null,
        scopes,
        ...(input.group === undefined ? {} : { group: input.group }),
        enabled: input.enabled ?? true,
        status: "INACTIVE",
    };
    const ref: Ref = { type: "EFFECT", unitId: unit.id, effectId: instance.id };

    updateUnit(battle, state.append(unit, instance));
    invoke(battle, ref, instance, "onApply");
    reconcile(battle, unit.id);

    return ref;
}

export function setState<S extends object, H extends object>(
    battle: BattleState,
    ref: Ref,
    definition: Definition<S, H>,
    next: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
): void {
    const instance = get(battle, ref);

    if (instance?.definition !== definition) {
        return;
    }

    const value = typeof next === "function" ? next(instance.state as S) : next;
    change(battle, ref, (current) => ({ ...current, state: value }));
}

export function setEnabled(battle: BattleState, ref: Ref, enabled: boolean): void {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "FINISHED" || instance.enabled === enabled) {
        return;
    }

    change(battle, ref, (current) => ({ ...current, enabled }));
    reconcile(battle, ref.unitId);
}

export function setTick(battle: BattleState, ref: Ref, tick: number | null): void {
    change(battle, ref, (instance) => ({
        ...instance,
        scopes: [
            ...instance.scopes.filter((scope) => scope.type !== "TICK"),
            ...(tick === null ? [] : [{ type: "TICK" as const, tick }]),
        ],
    }));
}

function wouldCycle(battle: BattleState, ref: Ref, lifetime: Lifetime): boolean {
    if (lifetime.type !== "EFFECT") {
        return false;
    }

    const pending: Ref[] = [lifetime];
    const seen = new Set<string>();

    while (pending.length > 0) {
        const current = pending.pop()!;
        const identity = key(current);

        if (identity === key(ref)) {
            return true;
        }
        if (seen.has(identity)) {
            continue;
        }

        seen.add(identity);
        pending.push(
            ...(get(battle, current)?.scopes.filter(
                (scope): scope is Ref => scope.type === "EFFECT",
            ) ?? []),
        );
    }

    return false;
}

export function bind(battle: BattleState, ref: Ref, lifetime: Lifetime): boolean {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "FINISHED" || !available(battle, lifetime)) {
        return false;
    }
    if (wouldCycle(battle, ref, lifetime)) {
        throw new TypeError("effect scopes cannot form a cycle");
    }
    if (!instance.scopes.some((scope) => key(scope) === key(lifetime))) {
        change(battle, ref, (current) => ({ ...current, scopes: [...current.scopes, lifetime] }));
    }

    return true;
}

export function end(battle: BattleState, ref: Ref, reason = "EXPLICIT"): Value | undefined {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "FINISHED") {
        return instance;
    }

    const children = dependents(battle, ref);
    const host = getUnit(battle, ref.unitId)!;
    change(battle, ref, (current) => ({ ...current, status: "FINISHED" }));
    let finished = get(battle, ref)!;

    if (instance.status === "ACTIVE") {
        finished = invoke(battle, ref, finished, "onDisable", reason, host);
    }

    reconcile(battle, ref.unitId);

    for (const child of children) {
        end(battle, child, reason);
    }

    finished = invoke(battle, ref, get(battle, ref) ?? finished, "onEnd", reason, host);
    transitionUnit(battle, ref.unitId, (unit) => state.remove(unit, ref.effectId));

    return finished;
}

export function endScope(battle: BattleState, lifetime: Lifetime, reason = "SCOPE_CLOSED"): void {
    const identity = key(lifetime);

    battle.closedLifetimes.add(identity);
    const roots = dependents(battle, lifetime);

    if (lifetime.type === "UNIT") {
        const hosted = getUnit(battle, lifetime.unitId)?.effects.instances ?? [];

        for (const instance of hosted) {
            end(battle, { type: "EFFECT", unitId: lifetime.unitId, effectId: instance.id }, reason);
        }
    }

    for (const ref of roots) {
        end(battle, ref, reason);
    }
}

export function advance(battle: BattleState): void {
    const view = battlefieldView(battle);
    const candidates = view.unitIds.flatMap((unitId) =>
        view.getUnit(unitId)!.effects.instances.map((instance): Ref => ({
            type: "EFFECT",
            unitId,
            effectId: instance.id,
        })),
    );

    for (const ref of candidates) {
        const instance = get(battle, ref);

        if (instance?.status === "ACTIVE") {
            invoke(battle, ref, instance, "onTick");
        }

        const current = get(battle, ref);
        const expires = current === undefined ? null : deadline(current);

        if (expires !== null && expires <= battle.tick) {
            end(battle, ref, "EXPIRED");
        }
    }
}

export function validateScopes(battle: BattleState): void {
    for (const unitId of battlefieldView(battle).unitIds) {
        for (const instance of getUnit(battle, unitId)!.effects.instances) {
            const ref: Ref = { type: "EFFECT", unitId, effectId: instance.id };

            for (const scope of instance.scopes) {
                if (scope.type === "TICK") {
                    continue;
                }
                if (!available(battle, scope)) {
                    throw new TypeError(`unavailable effect scope ${key(scope)}`);
                }
                if (wouldCycle(battle, ref, scope)) {
                    throw new TypeError("effect scopes cannot form a cycle");
                }
            }
        }
    }
}

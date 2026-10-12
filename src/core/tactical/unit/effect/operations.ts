import {
    battlefieldView,
    getUnit,
    transitionUnit,
    updateUnit,
    type BattleState,
    type Result,
} from "../../battle/state.js";
import { emptyCall, type CallContext } from "../../battle/execution/call.js";
import type { Unit, UnitId } from "../unit.js";
import type { Definition, EndContext } from "./definition.js";
import { deadline, key, type Effect, type Lifetime, type Ref, type Scope } from "./effect.js";
import { dependents } from "../../battlefield/storage/effect-lifetimes.js";

type StoredEffect = ReturnType<Unit["effects"]["values"]>[number];

export interface Initial<S extends object> {
    readonly source?: UnitId | null;
    readonly scopes?: readonly Scope[];
    readonly data?: S;
    readonly enabled?: boolean;
}

export function get(battle: BattleState, ref: Ref): StoredEffect | undefined {
    return getUnit(battle, ref.unitId)?.effects.get(ref.effectId);
}

export function install<S extends object, H extends object>(
    battle: BattleState,
    host: Unit & NoInfer<H>,
    definition: Definition<S, H>,
    initial: Initial<NoInfer<S>> = {},
    call: CallContext = emptyCall,
): Result<Ref | undefined> {
    const unit = getUnit(battle, host.id);
    const scopes = initial.scopes ?? [];

    if (
        unit === undefined ||
        !available(battle, { type: "UNIT", unitId: host.id }) ||
        scopes.some((scope) => scope.type !== "TICK" && !available(battle, scope))
    ) {
        return { state: battle, value: undefined };
    }

    const instance: Effect<S, H> = {
        id: unit.effects.nextId,
        definition,
        data: initial.data ?? definition.initialize(),
        source: initial.source ?? null,
        scopes,
        enabled: initial.enabled ?? true,
        status: "INSTALLING",
    };
    const ref: Ref = { type: "EFFECT", unitId: unit.id, effectId: instance.id };
    battle = updateUnit(battle, { ...unit, effects: unit.effects.add(instance) });

    if (definition.onInstall !== undefined) {
        battle = definition.onInstall(battle, createContext<S, H>(battle, ref, instance, call));
    }
    if (get(battle, ref)?.status === "INSTALLING") {
        battle = change(battle, ref, (current) => ({ ...current, status: "INACTIVE" }));
        battle =
            definition.group === undefined
                ? updateStatus(battle, ref, call)
                : reconcileGroupActivity(battle, unit.id, definition.group.id, call);
    }

    return { state: battle, value: ref };
}

export function setData<S extends object, H extends object>(
    effect: Effect<S, H>,
    next: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
): Effect<S, H> {
    const value = typeof next === "function" ? next(effect.data) : next;

    return value === effect.data ? effect : { ...effect, data: value };
}

export function replaceEffect<S extends object, H extends object>(
    battle: BattleState,
    unitId: UnitId,
    effect: Effect<S, H>,
): BattleState {
    return transitionUnit(battle, unitId, (unit) => ({
        ...unit,
        effects: unit.effects.replace(effect),
    }));
}

export function setEnabled(
    battle: BattleState,
    ref: Ref,
    enabled: boolean,
    call: CallContext = emptyCall,
): BattleState {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING" || instance.enabled === enabled) {
        return battle;
    }

    battle = change(battle, ref, (current) => ({ ...current, enabled }));

    return updateStatus(battle, ref, call);
}

export function setDeadline<S extends object, H extends object>(
    effect: Effect<S, H>,
    tick: number | null,
): Effect<S, H> {
    return {
        ...effect,
        scopes: [
            ...effect.scopes.filter((scope) => scope.type !== "TICK"),
            ...(tick === null ? [] : [{ type: "TICK" as const, tick }]),
        ],
    };
}

export function bind(battle: BattleState, ref: Ref, lifetime: Lifetime): Result<boolean> {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING" || !available(battle, lifetime)) {
        return { state: battle, value: false };
    }

    if (wouldCycle(battle, ref, lifetime)) {
        throw new TypeError("effect scopes cannot form a cycle");
    }
    if (!instance.scopes.some((scope) => key(scope) === key(lifetime))) {
        battle = change(battle, ref, (current) => ({
            ...current,
            scopes: [...current.scopes, lifetime],
        }));
    }

    return { state: battle, value: true };
}

export function end(
    battle: BattleState,
    ref: Ref,
    reason = "EXPLICIT",
    call: CallContext = emptyCall,
): Result<StoredEffect | undefined> {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING") {
        return { state: battle, value: instance };
    }

    const children = dependents(battlefieldView(battle).effectLifetimes, ref);
    const host = getUnit(battle, ref.unitId)!;

    return host.effects.read<Result<StoredEffect | undefined>>(ref.effectId, (instance) => {
        const definition = instance.definition;
        battle = change(battle, ref, (current) => ({ ...current, status: "ENDING" }));
        let ended = getUnit(battle, ref.unitId)!.effects.get(ref.effectId, definition)!;
        const disabling = createContext(battle, ref, ended, call, reason, host);

        if (instance.status === "ACTIVE" && definition.onDisable !== undefined) {
            battle = definition.onDisable(battle, disabling);
            ended = getUnit(battle, ref.unitId)?.effects.get(ref.effectId, definition) ?? ended;
        }

        for (const child of children) {
            battle = end(battle, child, reason, call).state;
        }

        ended = getUnit(battle, ref.unitId)?.effects.get(ref.effectId, definition) ?? ended;
        const ending = createContext(battle, ref, ended, call, reason, host);

        if (definition.onEnd !== undefined) {
            battle = definition.onEnd(battle, ending);
            ended = getUnit(battle, ref.unitId)?.effects.get(ref.effectId, definition) ?? ended;
        }

        battle = transitionUnit(battle, ref.unitId, (unit) => ({
            ...unit,
            effects: unit.effects.remove(ref.effectId),
        }));

        if (definition.group !== undefined) {
            battle = reconcileGroupActivity(battle, ref.unitId, definition.group.id, call);
        }

        return { state: battle, value: ended };
    })!;
}

export function endScope(
    battle: BattleState,
    lifetime: Lifetime,
    reason = "SCOPE_CLOSED",
    call: CallContext = emptyCall,
): BattleState {
    if (lifetime.type === "UNIT") {
        battle = transitionUnit(battle, lifetime.unitId, (unit) =>
            unit.lifecycle === "LEAVING" ? unit : { ...unit, lifecycle: "LEAVING" },
        );
    } else {
        battle = {
            ...battle,
            closedLifetimes: new Set([...battle.closedLifetimes, key(lifetime)]),
        };
    }

    const roots = dependents(battlefieldView(battle).effectLifetimes, lifetime);

    if (lifetime.type === "UNIT") {
        const hosted = getUnit(battle, lifetime.unitId)?.effects.values() ?? [];

        for (const instance of hosted) {
            battle = end(
                battle,
                { type: "EFFECT", unitId: lifetime.unitId, effectId: instance.id },
                reason,
                call,
            ).state;
        }
    }

    for (const ref of roots) {
        battle = end(battle, ref, reason, call).state;
    }

    return battle;
}

export function advance(battle: BattleState, call: CallContext = emptyCall): BattleState {
    const view = battlefieldView(battle);
    const candidates = view.unitIds.flatMap((unitId) =>
        view
            .getUnit(unitId)!
            .effects.values()
            .map((instance): Ref => ({
                type: "EFFECT",
                unitId,
                effectId: instance.id,
            })),
    );

    for (const ref of candidates) {
        battle =
            getUnit(battle, ref.unitId)?.effects.read(ref.effectId, (instance) => {
                if (instance.status !== "ACTIVE" || instance.definition.onTick === undefined) {
                    return battle;
                }

                return instance.definition.onTick(
                    battle,
                    createContext(battle, ref, instance, call),
                );
            }) ?? battle;

        const current = get(battle, ref);
        const expires = current === undefined ? null : deadline(current);

        if (expires !== null && expires <= battle.tick) {
            battle = end(battle, ref, "EXPIRED", call).state;
        }
    }

    return battle;
}

export function validateScopes(battle: BattleState): void {
    for (const unitId of battlefieldView(battle).unitIds) {
        for (const instance of getUnit(battle, unitId)!.effects.values()) {
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

function createContext<S extends object = object, H extends object = object>(
    battle: BattleState,
    ref: Ref,
    instance: Effect<S, H>,
    call: CallContext,
    reason = "EXPLICIT",
    host = getUnit(battle, ref.unitId)!,
): EndContext<S, H> {
    return {
        tick: battle.tick,
        ref,
        reason,
        call,
        unit: (getUnit(battle, ref.unitId) ?? host) as Unit & H,
        self: instance,
    };
}

function available(battle: BattleState, lifetime: Lifetime): boolean {
    if (battle.closedLifetimes.has(key(lifetime))) {
        return false;
    }
    switch (lifetime.type) {
        case "UNIT":
            return getUnit(battle, lifetime.unitId)?.lifecycle === "PRESENT";

        case "ACTION":
            return battle.actionExecutions.executions.some(
                (execution) => execution.id === lifetime.executionId,
            );

        case "SKILL":
            return getUnit(battle, lifetime.unitId)?.skill?.active?.id === lifetime.activationId;

        case "EFFECT": {
            const instance = get(battle, lifetime);

            return instance !== undefined && instance.status !== "ENDING";
        }
    }
}

function change(
    battle: BattleState,
    ref: Ref,
    next: <S extends object, H extends object>(instance: Effect<S, H>) => Effect<S, H>,
): BattleState {
    return (
        getUnit(battle, ref.unitId)?.effects.read(ref.effectId, (instance) =>
            replaceEffect(battle, ref.unitId, next(instance)),
        ) ?? battle
    );
}

function shouldBeActive(battle: BattleState, instance: StoredEffect, unit: Unit): boolean {
    if (
        !instance.enabled ||
        instance.status === "ENDING" ||
        !available(battle, { type: "UNIT", unitId: unit.id }) ||
        instance.scopes.some((scope) => scope.type !== "TICK" && !available(battle, scope))
    ) {
        return false;
    }

    const group = instance.definition.group;

    return (
        group === undefined ||
        !unit.effects
            .values()
            .some(
                (other) =>
                    other.status !== "ENDING" &&
                    other.definition.group?.id === group.id &&
                    (other.definition.group.priority > group.priority ||
                        (other.definition.group.priority === group.priority &&
                            other.id < instance.id)),
            )
    );
}

function updateStatus(battle: BattleState, ref: Ref, call: CallContext): BattleState {
    const unit = getUnit(battle, ref.unitId);
    const instance = get(battle, ref);

    if (
        unit === undefined ||
        instance === undefined ||
        instance.status === "ENDING" ||
        instance.status === "INSTALLING"
    ) {
        return battle;
    }

    const active = shouldBeActive(battle, instance, unit);

    if (active === (instance.status === "ACTIVE")) {
        return battle;
    }

    battle = change(battle, ref, (current) => ({
        ...current,
        status: active ? "ACTIVE" : "INACTIVE",
    }));

    return getUnit(battle, ref.unitId)!.effects.read(ref.effectId, (current) => {
        const context = createContext(battle, ref, current, call);
        const callback = active ? current.definition.onEnable : current.definition.onDisable;

        return callback === undefined ? battle : callback(battle, context);
    })!;
}

function reconcileGroupActivity(
    battle: BattleState,
    unitId: UnitId,
    groupId: string,
    call: CallContext,
): BattleState {
    const refs = (getUnit(battle, unitId)?.effects.values() ?? [])
        .filter((instance) => instance.definition.group?.id === groupId)
        .map((instance): Ref => ({ type: "EFFECT", unitId, effectId: instance.id }));

    for (const ref of refs) {
        if (get(battle, ref)?.status === "ACTIVE") {
            battle = updateStatus(battle, ref, call);
        }
    }
    for (const ref of refs) {
        if (get(battle, ref)?.status === "INACTIVE") {
            battle = updateStatus(battle, ref, call);
        }
    }

    return battle;
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

import {
    battlefieldView,
    getUnit,
    transitionUnit,
    updateUnit,
    type State as BattleState,
    type Result,
} from "../../battle/state.js";
import type { Unit, Id } from "../unit.js";
import type { Ref } from "../../../common/ref.js";
import * as units from "../query.js";
import { hasAction } from "../capability/action/capability.js";
import { get as getBurst } from "../capability/elemental/query.js";
import { get as getActivation } from "../capability/skill/query.js";
import type { Definition, Context } from "./definition.js";
import {
    deadline,
    key,
    type Effect,
    type Lifetime,
    ref as effectRef,
    type Scope,
    type Status,
} from "./effect.js";
import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { dependents } from "../../battlefield/storage/effect-lifetimes.js";

type StoredEffect = ReturnType<Unit["effects"]["values"]>[number];

export interface Initial<S extends object> {
    readonly source?: Id | null;
    readonly scopes?: readonly Scope[];
    readonly data?: S;
    readonly enabled?: boolean;
}

export function get<E extends StoredEffect>(battle: BattleState, ref: Ref<E>): E | undefined {
    return units.get(battle, ref.host)?.effects.get(ref.id) as E | undefined;
}

export function install<S extends object, H extends object>(
    battle: BattleState,
    host: Ref<Unit & NoInfer<H>>,
    definition: Definition<S, H>,
    initial: Initial<NoInfer<S>> = {},
): Result<Ref<Effect<S, H>> | undefined> {
    const unit = units.get(battle, host);
    const scopes = initial.scopes ?? [];

    for (const scope of scopes) {
        if (scope.type === "TICK") {
            assertNonnegativeSafeInteger(scope.tick, "effect deadline");
        }
    }

    if (
        unit === undefined ||
        !available(battle, { type: "UNIT", unitId: host.id }) ||
        scopes.some((scope) => scope.type !== "TICK" && !available(battle, scope))
    ) {
        return { state: battle, value: undefined };
    }

    const instance: Effect<S, H> = {
        id: unit.effects.nextId,
        host,
        definition,
        data: initial.data ?? definition.initialize(),
        source: initial.source ?? null,
        scopes,
        enabled: initial.enabled ?? true,
        status: "INSTALLING",
    };
    const ref = effectRef(instance);
    battle = updateUnit(battle, { ...unit, effects: unit.effects.add(instance) });

    if (definition.onInstall !== undefined) {
        battle = definition.onInstall(battle, createContext<S, H>(battle, instance));
    }
    if (get(battle, ref)?.status === "INSTALLING") {
        battle = change(battle, ref, { status: "INACTIVE" });
        battle =
            definition.group === undefined
                ? updateStatus(battle, ref)
                : reconcileGroupActivity(battle, unit.id, definition.group.id);
    }

    return { state: battle, value: ref };
}

export function replaceEffect<S extends object, H extends object>(
    battle: BattleState,
    ref: Ref<Effect<S, H>>,
    effect: NoInfer<Effect<S, H>>,
): BattleState {
    if (ref.id !== effect.id || ref.host.id !== effect.host.id) {
        throw new TypeError("effect identity mismatch");
    }

    return transitionUnit(battle, ref.host.id, (unit) => {
        const effects = unit.effects.replace(effect);

        return effects === unit.effects ? unit : { ...unit, effects };
    });
}

export function setEnabled(
    battle: BattleState,
    ref: Ref<StoredEffect>,
    enabled: boolean,
): BattleState {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING" || instance.enabled === enabled) {
        return battle;
    }

    battle = change(battle, ref, { enabled });

    return updateStatus(battle, ref);
}

export function bindLifetime(
    battle: BattleState,
    ref: Ref<StoredEffect>,
    lifetime: Lifetime,
): Result<boolean> {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING" || !available(battle, lifetime)) {
        return { state: battle, value: false };
    }

    if (wouldCycle(battle, ref, lifetime)) {
        throw new TypeError("effect scopes cannot form a cycle");
    }
    if (!instance.scopes.some((scope) => key(scope) === key(lifetime))) {
        battle = change(battle, ref, { scopes: [...instance.scopes, lifetime] });
    }

    return { state: battle, value: true };
}

export function end(battle: BattleState, ref: Ref<StoredEffect>, reason = "EXPLICIT"): BattleState {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING") {
        return battle;
    }

    const children = dependents(battlefieldView(battle).effectLifetimes, { type: "EFFECT", ref });
    const host = units.get(battle, ref.host)!;

    return host.effects.read(ref.id, (instance) => {
        const initialHost = units.get(battle, instance.host)!;
        const definition = instance.definition;
        battle = change(battle, ref, { status: "ENDING" });
        let ended = getUnit(battle, ref.host.id)!.effects.get(ref.id, definition)!;
        const disabling = createContext(battle, ended, initialHost);

        if (instance.status === "ACTIVE" && definition.onDisable !== undefined) {
            battle = definition.onDisable(battle, disabling);
            ended = getUnit(battle, ref.host.id)?.effects.get(ref.id, definition) ?? ended;
        }

        for (const child of children) {
            battle = end(battle, child, reason);
        }

        ended = getUnit(battle, ref.host.id)?.effects.get(ref.id, definition) ?? ended;
        const ending = { ...createContext(battle, ended, initialHost), reason };

        if (definition.onEnd !== undefined) {
            battle = definition.onEnd(battle, ending);
        }

        battle = transitionUnit(battle, ref.host.id, (unit) => ({
            ...unit,
            effects: unit.effects.remove(ref.id),
        }));

        if (definition.group !== undefined) {
            battle = reconcileGroupActivity(battle, ref.host.id, definition.group.id);
        }

        return battle;
    })!;
}

export function endDependents(
    battle: BattleState,
    lifetime: Lifetime,
    reason = "SCOPE_CLOSED",
): BattleState {
    const roots = dependents(battlefieldView(battle).effectLifetimes, lifetime);

    if (lifetime.type === "UNIT") {
        const hosted = getUnit(battle, lifetime.unitId)?.effects.values() ?? [];

        for (const instance of hosted) {
            battle = end(battle, effectRef(instance), reason);
        }
    }

    for (const ref of roots) {
        battle = end(battle, ref, reason);
    }

    return battle;
}

export function advance(battle: BattleState): BattleState {
    const candidates = units
        .all(battle)
        .flatMap((host) => host.effects.values().map(effectRef))
        .toArray();

    for (const ref of candidates) {
        battle =
            getUnit(battle, ref.host.id)?.effects.read(ref.id, (instance) => {
                if (instance.status !== "ACTIVE" || instance.definition.onTick === undefined) {
                    return battle;
                }

                return instance.definition.onTick(battle, createContext(battle, instance));
            }) ?? battle;

        const current = get(battle, ref);
        const expires = current === undefined ? null : deadline(current);

        if (expires !== null && expires <= battle.tick) {
            battle = end(battle, ref, "EXPIRED");
        }
    }

    return battle;
}

export function validateScopes(battle: BattleState): void {
    for (const unitId of battlefieldView(battle).unitIds) {
        for (const instance of getUnit(battle, unitId)!.effects.values()) {
            const ref = effectRef(instance);

            for (const scope of instance.scopes) {
                if (scope.type === "TICK") {
                    assertNonnegativeSafeInteger(scope.tick, "effect deadline");
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

function createContext<S extends object, H extends object>(
    battle: BattleState,
    instance: Effect<S, H>,
    host = units.get(battle, instance.host)!,
): Context<S, H> {
    return {
        tick: battle.tick,
        ref: effectRef(instance),
        unit: units.get(battle, instance.host) ?? host,
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

        case "ACTION": {
            const unit = getUnit(battle, lifetime.ref.host.id);

            return (
                unit !== undefined &&
                hasAction(unit) &&
                unit.action.instances.get(lifetime.ref.id)?.status === "RUNNING"
            );
        }

        case "SKILL": {
            return getActivation(battle, lifetime.ref)?.status === "ACTIVE";
        }

        case "ELEMENTAL_BURST":
            return getBurst(battle, lifetime.ref)?.status === "ACTIVE";

        case "EFFECT": {
            const instance = get(battle, lifetime.ref);

            return instance !== undefined && instance.status !== "ENDING";
        }
    }
}

function change(
    battle: BattleState,
    ref: Ref<StoredEffect>,
    changes: {
        readonly status?: Status;
        readonly enabled?: boolean;
        readonly scopes?: readonly Scope[];
    },
): BattleState {
    return (
        getUnit(battle, ref.host.id)?.effects.read(ref.id, (instance) =>
            replaceEffect(battle, effectRef(instance), { ...instance, ...changes }),
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

function updateStatus(battle: BattleState, ref: Ref<StoredEffect>): BattleState {
    const unit = getUnit(battle, ref.host.id);
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

    battle = change(battle, ref, { status: active ? "ACTIVE" : "INACTIVE" });

    return getUnit(battle, ref.host.id)!.effects.read(ref.id, (current) => {
        const context = createContext(battle, current);
        const callback = active ? current.definition.onEnable : current.definition.onDisable;

        return callback === undefined ? battle : callback(battle, context);
    })!;
}

function reconcileGroupActivity(battle: BattleState, unitId: Id, groupId: string): BattleState {
    const refs = (getUnit(battle, unitId)?.effects.values() ?? [])
        .filter((instance) => instance.definition.group?.id === groupId)
        .map(effectRef);

    for (const ref of refs) {
        if (get(battle, ref)?.status === "ACTIVE") {
            battle = updateStatus(battle, ref);
        }
    }
    for (const ref of refs) {
        if (get(battle, ref)?.status === "INACTIVE") {
            battle = updateStatus(battle, ref);
        }
    }

    return battle;
}

function wouldCycle(battle: BattleState, ref: Ref<StoredEffect>, lifetime: Lifetime): boolean {
    if (lifetime.type !== "EFFECT") {
        return false;
    }

    const pending: Ref<StoredEffect>[] = [lifetime.ref];
    const seen = new Set<string>();

    while (pending.length > 0) {
        const current = pending.pop()!;
        const identity = key({ type: "EFFECT", ref: current });

        if (identity === key({ type: "EFFECT", ref })) {
            return true;
        }
        if (seen.has(identity)) {
            continue;
        }

        seen.add(identity);
        pending.push(
            ...(get(battle, current)
                ?.scopes.filter(
                    (scope): scope is Extract<Lifetime, { type: "EFFECT" }> =>
                        scope.type === "EFFECT",
                )
                .map((scope) => scope.ref) ?? []),
        );
    }

    return false;
}

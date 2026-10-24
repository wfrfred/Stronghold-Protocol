import {
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
import type { Definition } from "./definition.js";
import {
    deadline,
    key,
    type Effect,
    type Lifetime,
    ref as effectRef,
    type Scope,
    type Status,
    type View,
} from "./effect.js";
import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { dependents } from "./dependency.js";

export interface Initial<S extends object> {
    readonly source?: Id | null;
    readonly scopes?: readonly Scope[];
    readonly data?: S;
    readonly enabled?: boolean;
}

export function get<E extends View>(battle: BattleState, ref: Ref<E>): E | undefined {
    return units.get(battle, ref.host)?.effects.get(ref);
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
        !available(battle, { type: "UNIT", ref: host }) ||
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

    const installed = get(battle, ref);

    if (installed?.status === "INSTALLING" && definition.onInstall !== undefined) {
        battle = definition.onInstall(battle, installed);
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

export function update<S extends object, H extends object>(
    battle: BattleState,
    ref: Ref<Effect<S, H>>,
    transform: (data: NoInfer<S>) => NoInfer<S>,
): BattleState {
    const unit = units.get(battle, ref.host);

    if (unit === undefined) {
        return battle;
    }

    const self = unit.effects.get(ref);

    if (self === undefined) {
        return battle;
    }

    const data = transform(self.data);

    return data === self.data
        ? battle
        : updateUnit(battle, { ...unit, effects: unit.effects.replace(ref, { ...self, data }) });
}

export function setEnabled(battle: BattleState, ref: Ref<View>, enabled: boolean): BattleState {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING" || instance.enabled === enabled) {
        return battle;
    }

    battle = change(battle, ref, { enabled });

    return updateStatus(battle, ref);
}

export function bindLifetime(
    battle: BattleState,
    ref: Ref<View>,
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

export function end(battle: BattleState, ref: Ref<View>, reason = "EXPLICIT"): BattleState {
    const instance = get(battle, ref);

    if (instance === undefined || instance.status === "ENDING") {
        return battle;
    }

    const children = dependents(battle.effect.dependency, { type: "EFFECT", ref });
    const host = units.get(battle, ref.host)!;

    return host.effects.read(ref.id, (instance) => {
        const definition = instance.definition;
        const reference = effectRef(instance);
        const ending = { ...instance, status: "ENDING" as const };
        battle = change(battle, ref, { status: "ENDING" });
        let ended = get(battle, reference) ?? ending;

        if (instance.status === "ACTIVE" && definition.onDisable !== undefined) {
            battle = definition.onDisable(battle, ended);
            ended = get(battle, reference) ?? ended;
        }

        for (const child of children) {
            battle = end(battle, child, reason);
            ended = get(battle, reference) ?? ended;
        }

        if (definition.onEnd !== undefined) {
            battle = definition.onEnd(battle, ended, reason);
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
    const roots = dependents(battle.effect.dependency, lifetime);

    if (lifetime.type === "UNIT") {
        const hosted =
            units.get(battle, lifetime.ref)?.effects.values().map(effectRef).toArray() ?? [];

        for (const ref of hosted) {
            battle = end(battle, ref, reason);
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

                return instance.definition.onTick(battle, instance);
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
    for (const unit of units.all(battle)) {
        for (const instance of unit.effects.values()) {
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

function available(battle: BattleState, lifetime: Lifetime): boolean {
    switch (lifetime.type) {
        case "UNIT":
            return units.get(battle, lifetime.ref)?.lifecycle === "PRESENT";

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
    ref: Ref<View>,
    changes: {
        readonly status?: Status;
        readonly enabled?: boolean;
        readonly scopes?: readonly Scope[];
    },
): BattleState {
    return transitionUnit(
        battle,
        ref.host.id,
        (unit) =>
            unit.effects.read(ref.id, (instance) => {
                const effects = unit.effects.replace(effectRef(instance), {
                    ...instance,
                    ...changes,
                });

                return effects === unit.effects ? unit : { ...unit, effects };
            }) ?? unit,
    );
}

function shouldBeActive(battle: BattleState, instance: View, unit: Unit): boolean {
    if (
        !instance.enabled ||
        instance.status === "ENDING" ||
        !available(battle, { type: "UNIT", ref: units.ref(unit) }) ||
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

function updateStatus(battle: BattleState, ref: Ref<View>): BattleState {
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

    return (
        units.get(battle, ref.host)?.effects.read(ref.id, (current) => {
            if (current.status !== (active ? "ACTIVE" : "INACTIVE")) {
                return battle;
            }

            const callback = active ? current.definition.onEnable : current.definition.onDisable;

            return callback === undefined ? battle : callback(battle, current);
        }) ?? battle
    );
}

function reconcileGroupActivity(battle: BattleState, unitId: Id, groupId: string): BattleState {
    const refs =
        getUnit(battle, unitId)
            ?.effects.values()
            .filter((instance) => instance.definition.group?.id === groupId)
            .map(effectRef)
            .toArray() ?? [];

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

function wouldCycle(battle: BattleState, ref: Ref<View>, lifetime: Lifetime): boolean {
    if (lifetime.type !== "EFFECT") {
        return false;
    }

    const pending: Ref<View>[] = [lifetime.ref];
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

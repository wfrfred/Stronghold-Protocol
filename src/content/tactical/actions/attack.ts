import type { Ref } from "../../../core/common/ref.js";
import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
} from "../../../core/common/assert.js";
import {
    appendEvents,
    type State as BattleState,
    type Result,
} from "../../../core/tactical/battle/state.js";
import type { Unit } from "../../../core/tactical/unit/unit.js";
import * as units from "../../../core/tactical/unit/query.js";
import { ref, setState, type Action } from "../../../core/tactical/unit/action/action.js";
import type { Definition as ActionDefinition } from "../../../core/tactical/unit/action/definition.js";
import type { State as ActionState } from "../../../core/tactical/unit/action/state.js";
import * as actions from "../../../core/tactical/unit/action/operations.js";
import type { Action as ActionCapability } from "../../../core/tactical/unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../../core/tactical/unit/capability/presence/capability.js";
import { beforeRelease, released } from "../../../core/tactical/unit/capability/action/release.js";
import { hasOffense } from "../../../core/tactical/unit/capability/offense/capability.js";
import { resolveAttack } from "../../../core/tactical/unit/capability/offense/query.js";
import { calculateDamage } from "../../../core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../../core/tactical/battle/damage/apply.js";
import type { DamageRequest, DamageType } from "../../../core/tactical/battle/damage/contract.js";
import { hasVitality } from "../../../core/tactical/unit/capability/vitality/capability.js";
import { calculateHealing } from "../../../core/tactical/battle/healing/calculate.js";
import { applyHealing } from "../../../core/tactical/battle/healing/apply.js";
import type { HealingRequest } from "../../../core/tactical/battle/healing/contract.js";
import {
    damage as damageElement,
    heal as healElement,
} from "../../../core/tactical/unit/capability/elemental/operations.js";
import type { Type as ElementType } from "../../../core/tactical/unit/capability/elemental/capability.js";
import type { Request } from "../../../core/tactical/battle/targeting/contract.js";
import { select } from "../../../core/tactical/battle/targeting/select.js";

export type Operation =
    | {
          readonly type: "DAMAGE";
          readonly power: number;
          readonly damageType: DamageType;
          readonly powerSource?: "SOURCE_ATTACK";
      }
    | { readonly type: "HEAL"; readonly power: number }
    | { readonly type: "ELEMENT_DAMAGE"; readonly power: number; readonly elementType: ElementType }
    | { readonly type: "ELEMENT_HEAL"; readonly power: number };

export interface TargetGroup {
    readonly id: string;
    readonly targeting: Omit<Request, "source">;
    readonly operations: readonly Operation[];
}

export interface FollowUp {
    readonly receiver:
        { readonly type: "SOURCE" } | { readonly type: "BINDING"; readonly bindingId: string };
    readonly operation: Operation;
}

export interface Configuration {
    readonly id: string;
    readonly intervalTicks: number;
    readonly speed?: number;
    readonly triggerBindingId: string;
    readonly targetGroups: readonly [TargetGroup, ...TargetGroup[]];
    readonly followUps?: readonly FollowUp[];
    readonly windupTicks?: number;
    readonly recoveryTicks?: number;
    readonly markerId?: string;
}

export interface Definition<
    P extends object = object,
    E extends object = object,
> extends Configuration {
    readonly output?: (battle: BattleState, self: Action<P, State<E>>) => BattleState;
    readonly afterOutput?: (battle: BattleState, self: Action<P, State<E>>) => BattleState;
    readonly onEnd?: ActionDefinition<P, State<E>>["onEnd"];
}

export interface StatefulDefinition<P extends object, E extends object> extends Definition<P, E> {
    readonly initialize: (battle: BattleState) => Result<P>;
    readonly start: (
        battle: BattleState,
        source: Ref<Unit & ActionCapability>,
        self: ActionState<P, State<E>>,
    ) => Result<E>;
}

export interface State<S extends object = object> {
    readonly target: Ref<Unit>;
    readonly bindings: Readonly<Record<string, readonly Ref<Unit>[]>>;
    readonly releaseAtTick: number;
    readonly finishAtTick: number;
    readonly released: boolean;
    readonly previousReadyAtTick: number;
    readonly cooldownAdjusted: boolean;
    readonly data: S;
}

export interface Attack<
    P extends object = object,
    E extends object = object,
> extends ActionDefinition<P, State<E>> {
    readonly attack: Configuration;
}

export interface Stored extends Pick<ActionDefinition, "id" | "intervalTicks" | "speed"> {
    readonly attack: Configuration;
}

export function isAttack(value: unknown): value is Stored {
    return typeof value === "object" && value !== null && "attack" in value;
}

function sourcePresent(battle: BattleState, source: Ref<Unit>): boolean {
    const current = units.get(battle, source);

    return current?.lifecycle === "PRESENT" && isSpatiallyPresent(current);
}

export function chooseTargets(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definition: Configuration,
): Result<State["bindings"]> {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return { state: battle, value: {} };
    }

    const bindings: Record<string, readonly Ref<Unit>[]> = {};

    for (const group of definition.targetGroups) {
        const selected = select(battle, { ...group.targeting, source });
        battle = selected.state;
        bindings[group.id] = selected.value;
    }

    return { state: battle, value: bindings };
}

function apply(
    battle: BattleState,
    source: Ref<Unit>,
    target: Ref<Unit>,
    operation: Operation,
): BattleState {
    switch (operation.type) {
        case "DAMAGE": {
            const receiver = units.get(battle, target);
            let power: number | undefined = operation.power;

            if (operation.powerSource === "SOURCE_ATTACK") {
                const current = units.get(battle, source);

                if (current === undefined) {
                    power = undefined;
                } else if (hasOffense(current)) {
                    power = resolveAttack(battle, units.ref(current));
                } else {
                    power = 0;
                }
            }

            if (power === undefined || receiver === undefined || !hasVitality(receiver)) {
                return battle;
            }

            const attack = { power, multiplier: 1, addition: 0 };
            const type = operation.damageType;
            const request: DamageRequest = {
                source,
                target: units.ref(receiver),
                parameters:
                    type === "PHYSICAL" || type === "ARTS"
                        ? { type, attack, penetration: { fixed: 0, proportional: 0 } }
                        : { type, attack },
            };

            return applyDamage(request, calculateDamage(battle, request)).state;
        }

        case "HEAL": {
            const receiver = units.get(battle, target);

            if (receiver === undefined || !hasVitality(receiver)) {
                return battle;
            }

            const request: HealingRequest = {
                source,
                target: units.ref(receiver),
                parameters: { power: operation.power, multiplier: 1 },
            };

            return applyHealing(request, calculateHealing(battle, request)).state;
        }

        case "ELEMENT_DAMAGE":
            return damageElement(battle, target, {
                source,
                type: operation.elementType,
                power: operation.power,
            }).state;

        case "ELEMENT_HEAL":
            return healElement(battle, target, { source, power: operation.power }).state;
    }
}

export function create(definition: Definition): Attack {
    return createWithState({
        ...definition,
        initialize: (battle) => ({ state: battle, value: {} }),
        start: (battle) => ({ state: battle, value: {} }),
    });
}

export function createWithState<P extends object, E extends object>(
    definition: StatefulDefinition<P, E>,
): Attack<P, E> {
    assertPositiveNumber(definition.intervalTicks, "attack interval");
    assertNonnegativeSafeInteger(definition.windupTicks ?? 0, "attack windup");
    assertNonnegativeSafeInteger(definition.recoveryTicks ?? 0, "attack recovery");

    function copyOperation(operation: Operation): Operation {
        assertNonnegativeNumber(operation.power, "attack operation power");

        return Object.freeze({ ...operation });
    }

    const groups = definition.targetGroups.map((group) =>
        Object.freeze({
            id: group.id,
            targeting: group.targeting,
            operations: Object.freeze(group.operations.map(copyOperation)),
        }),
    );
    const ids = new Set(groups.map((group) => group.id));

    if (ids.has("") || ids.size !== groups.length || !ids.has(definition.triggerBindingId)) {
        throw new TypeError("attack target bindings must be unique and include its trigger");
    }

    const followUps = (definition.followUps ?? []).map((followUp) => {
        if (followUp.receiver.type === "BINDING" && !ids.has(followUp.receiver.bindingId)) {
            throw new TypeError("attack follow-up references an unknown target binding");
        }

        return Object.freeze({
            receiver: Object.freeze({ ...followUp.receiver }),
            operation: copyOperation(followUp.operation),
        });
    });
    definition = Object.freeze({
        ...definition,
        targetGroups: Object.freeze(groups) as Definition["targetGroups"],
        followUps: Object.freeze(followUps),
    });

    const configuration: Configuration = Object.freeze({
        id: definition.id,
        intervalTicks: definition.intervalTicks,
        triggerBindingId: definition.triggerBindingId,
        targetGroups: definition.targetGroups,
        followUps: Object.freeze(followUps),
        ...(definition.speed === undefined ? {} : { speed: definition.speed }),
        ...(definition.windupTicks === undefined ? {} : { windupTicks: definition.windupTicks }),
        ...(definition.recoveryTicks === undefined
            ? {}
            : { recoveryTicks: definition.recoveryTicks }),
        ...(definition.markerId === undefined ? {} : { markerId: definition.markerId }),
    });
    const attack: Attack<P, E> = {
        id: definition.id,
        intervalTicks: definition.intervalTicks,
        speed: definition.speed ?? 100,
        attack: configuration,
        initialize: definition.initialize,
        start(battle, source, self) {
            const selected = chooseTargets(battle, source, definition);
            battle = selected.state;
            const unit = units.get(battle, source);
            const bindings = selected.value;
            const target = bindings[definition.triggerBindingId]?.[0];

            if (unit === undefined || target === undefined) {
                return { state: battle, value: null };
            }

            const releaseAtTick = battle.tick + (definition.windupTicks ?? 0);
            const initialized = definition.start(battle, source, self);
            const current = actions.getState(initialized.state, source, self.definition);

            return {
                state: initialized.state,
                value: {
                    target,
                    bindings,
                    releaseAtTick,
                    finishAtTick: releaseAtTick + (definition.recoveryTicks ?? 0),
                    released: false,
                    previousReadyAtTick: current?.cooldown.readyAtTick ?? initialized.state.tick,
                    cooldownAdjusted: false,
                    data: initialized.value,
                },
            };
        },
        step(battle, self) {
            const identity = ref(self);

            if (!self.state.cooldownAdjusted) {
                const persistent = actions.getState(battle, self.host, self.definition);
                const overdue = self.startedAtTick - self.state.previousReadyAtTick;

                if (persistent !== undefined && overdue >= 0 && overdue < 1) {
                    battle = actions.replaceState(battle, self.host, {
                        ...persistent,
                        cooldown: {
                            ...persistent.cooldown,
                            readyAtTick:
                                self.state.previousReadyAtTick + persistent.cooldown.periodTicks,
                        },
                    });
                }

                self = setState(self, { ...self.state, cooldownAdjusted: true });
                battle = actions.replace(battle, self);
                battle = appendEvents(battle, [
                    {
                        type: "ACTION",
                        sourceUnitId: self.host.id,
                        targetUnitId: self.state.target.id,
                        tick: battle.tick,
                    },
                ]);
            }

            if (!self.state.released && battle.tick >= self.state.releaseAtTick) {
                battle = actions.replace(battle, setState(self, { ...self.state, released: true }));
                const permission = beforeRelease(battle, identity);
                battle = permission.state;
                const current = actions.get(battle, identity);

                if (current?.status !== "RUNNING" || !sourcePresent(battle, current.host)) {
                    return {
                        state: actions.cancel(battle, identity, "SOURCE_ABSENT"),
                        value: true,
                    };
                }
                if (permission.value.type === "INTERRUPT") {
                    const persistent = actions.getState(battle, self.host, self.definition);

                    if (persistent !== undefined) {
                        battle = actions.replaceState(battle, self.host, {
                            ...persistent,
                            cooldown: {
                                ...persistent.cooldown,
                                readyAtTick: Math.max(
                                    persistent.cooldown.readyAtTick,
                                    battle.tick + permission.value.recoveryTicks,
                                ),
                            },
                        });
                    }

                    return { state: actions.cancel(battle, identity, "INTERRUPTED"), value: true };
                }

                battle = appendEvents(battle, [
                    {
                        type: "ACTION_RELEASED",
                        executionId: self.id,
                        sourceUnitId: self.host.id,
                        tick: battle.tick,
                        markerId: definition.markerId ?? "normal-attack",
                    },
                ]);

                battle = released(battle, identity);

                const output = actions.get(battle, identity);

                if (output?.status !== "RUNNING" || !sourcePresent(battle, output.host)) {
                    return {
                        state: actions.cancel(battle, identity, "SOURCE_ABSENT"),
                        value: true,
                    };
                }

                if (definition.output !== undefined) {
                    battle = definition.output(battle, output);
                } else {
                    for (const group of definition.targetGroups) {
                        for (const operation of group.operations) {
                            for (const target of output.state.bindings[group.id] ?? []) {
                                if (actions.get(battle, identity)?.status !== "RUNNING") {
                                    return { state: battle, value: true };
                                }

                                battle = apply(battle, output.host, target, operation);
                            }
                        }
                    }
                    for (const followUp of definition.followUps ?? []) {
                        for (const target of followUp.receiver.type === "SOURCE"
                            ? [output.host]
                            : (output.state.bindings[followUp.receiver.bindingId] ?? [])) {
                            if (actions.get(battle, identity)?.status !== "RUNNING") {
                                return { state: battle, value: true };
                            }

                            battle = apply(battle, output.host, target, followUp.operation);
                        }
                    }
                }

                const completed = actions.get(battle, identity);

                if (completed?.status !== "RUNNING") {
                    return { state: battle, value: true };
                }

                if (definition.afterOutput !== undefined) {
                    battle = definition.afterOutput(battle, completed);
                }
            }

            const current = actions.get(battle, identity);

            return {
                state: battle,
                value: current === undefined || battle.tick >= current.state.finishAtTick,
            };
        },
        ...(definition.onEnd === undefined ? {} : { onEnd: definition.onEnd }),
    };

    return Object.freeze(attack);
}

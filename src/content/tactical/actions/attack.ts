import type { Ref } from "../../../core/common/ref.js";
import {
    assertNonnegativeNumber,
    assertNonnegativeSafeInteger,
    assertPositiveNumber,
} from "../../../core/common/assert.js";
import {
    appendEvents,
    battlefieldView,
    updateUnit,
    type State as BattleState,
} from "../../../core/tactical/battle/state.js";
import { CombatResources } from "../../../core/tactical/battle/resources.js";
import { gainUnitSkillSp } from "../../../core/tactical/battle/execution/skill-sp.js";
import type { Unit } from "../../../core/tactical/unit/unit.js";
import * as units from "../../../core/tactical/unit/query.js";
import { ref, setState, type Action } from "../../../core/tactical/unit/action/action.js";
import type { Definition as ActionDefinition } from "../../../core/tactical/unit/action/definition.js";
import * as actions from "../../../core/tactical/unit/action/operations.js";
import type { Action as ActionCapability } from "../../../core/tactical/unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../../core/tactical/unit/capability/presence/capability.js";
import { beforeRelease } from "../../../core/tactical/unit/capability/action/release.js";
import { consumeSkillAmmo } from "../../../core/tactical/unit/capability/skill/execution.js";
import { hasSkill } from "../../../core/tactical/unit/capability/skill/capability.js";
import { resolveAttackPower } from "../../../core/tactical/unit/capability/offense/query.js";
import { resolveDamage } from "../../../core/tactical/unit/capability/vitality/damage/settlement.js";
import {
    createDamageOperands,
    type DamageType,
} from "../../../core/tactical/unit/capability/vitality/damage/contract.js";
import { resolveHealing } from "../../../core/tactical/unit/capability/vitality/healing/settlement.js";
import { resolveMaxHp } from "../../../core/tactical/unit/capability/vitality/query.js";
import {
    resolveElementDamage,
    resolveElementHeal,
} from "../../../core/tactical/unit/capability/elemental/execution.js";
import type { ElementType } from "../../../core/tactical/unit/capability/elemental/capability.js";
import {
    createTargetingDefinition,
    type TargetingDefinition,
} from "../../../core/tactical/unit/targeting/definition.js";
import { compileTargeting } from "../../../core/tactical/unit/targeting/compile.js";
import { selectTargets } from "../../../core/tactical/unit/targeting/select.js";
import type { QueryPurpose } from "../../../core/tactical/unit/targeting/query.js";

export type Operation =
    | {
          readonly type: "DAMAGE";
          readonly power: number;
          readonly damageType: DamageType;
          readonly powerSource?: "SOURCE_ATTACK";
      }
    | { readonly type: "HEAL"; readonly power: number; readonly ignoreHealFree: boolean }
    | { readonly type: "ELEMENT_DAMAGE"; readonly power: number; readonly elementType: ElementType }
    | { readonly type: "ELEMENT_HEAL"; readonly power: number };

export interface TargetGroup {
    readonly id: string;
    readonly targeting: TargetingDefinition;
    readonly operations: readonly Operation[];
}

export interface FollowUp {
    readonly receiver:
        { readonly type: "SOURCE" } | { readonly type: "BINDING"; readonly bindingId: string };
    readonly operation: Operation;
}

export interface Definition {
    readonly id: string;
    readonly intervalTicks: number;
    readonly speed?: number;
    readonly triggerBindingId: string;
    readonly targetGroups: readonly [TargetGroup, ...TargetGroup[]];
    readonly followUps?: readonly FollowUp[];
    readonly windupTicks?: number;
    readonly recoveryTicks?: number;
    readonly markerId?: string;
    readonly output?: (battle: BattleState, self: Action<State>) => BattleState;
    readonly onEnd?: ActionDefinition<State>["onEnd"];
}

export interface State {
    readonly target: Ref<Unit>;
    readonly bindings: Readonly<Record<string, readonly Ref<Unit>[]>>;
    readonly releaseAtTick: number;
    readonly finishAtTick: number;
    readonly released: boolean;
    readonly previousReadyAtTick: number;
    readonly cooldownAdjusted: boolean;
    readonly activationId: number | null;
}

export interface Attack extends ActionDefinition<State> {
    readonly attack: Definition;
}

export function isAttack(value: unknown): value is Attack {
    return typeof value === "object" && value !== null && "attack" in value;
}

function purposes(operation: Operation): readonly QueryPurpose[] {
    return [operation.type];
}

function sourcePresent(battle: BattleState, source: Ref<Unit>): boolean {
    const current = units.get(battle, source);

    return current?.lifecycle === "PRESENT" && isSpatiallyPresent(current);
}

export function chooseTargets(
    battle: BattleState,
    source: Ref<Unit & ActionCapability>,
    definition: Definition,
): State["bindings"] {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return {};
    }

    const context = { source: unit, battlefield: battlefieldView(battle) };

    return Object.fromEntries(
        definition.targetGroups.map((group) => [
            group.id,
            selectTargets(
                context,
                compileTargeting(
                    group.targeting,
                    group.operations.flatMap(purposes),
                    (target, query) => resolveMaxHp(target.id, query.battlefield)!,
                ),
            ).map(units.ref),
        ]),
    );
}

function apply(
    battle: BattleState,
    source: Ref<Unit>,
    target: Ref<Unit>,
    operation: Operation,
    resources: CombatResources,
): BattleState {
    const tick = battle.tick;
    const sourceUnitId = source.id;
    const targetUnitId = target.id;

    switch (operation.type) {
        case "DAMAGE": {
            const power =
                operation.powerSource === "SOURCE_ATTACK"
                    ? resolveAttackPower(sourceUnitId, battlefieldView(battle))
                    : operation.power;

            return power === undefined
                ? battle
                : resolveDamage(
                      battle,
                      {
                          sourceUnitId,
                          targetUnitId,
                          tick,
                          damageType: operation.damageType,
                          operands: createDamageOperands(power),
                      },
                      resources,
                  ).state;
        }

        case "HEAL":
            return resolveHealing(battle, {
                sourceUnitId,
                targetUnitId,
                tick,
                power: operation.power,
                ignoreHealFree: operation.ignoreHealFree,
            }).state;

        case "ELEMENT_DAMAGE":
            return resolveElementDamage(
                battle,
                {
                    sourceUnitId,
                    targetUnitId,
                    tick,
                    type: operation.elementType,
                    power: operation.power,
                },
                resources,
            ).state;

        case "ELEMENT_HEAL":
            return resolveElementHeal(battle, {
                sourceUnitId,
                targetUnitId,
                tick,
                power: operation.power,
            }).state;
    }
}

export function create(definition: Definition, resources = new CombatResources()): Attack {
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
            targeting: createTargetingDefinition(group.targeting),
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

    const attack: Attack = {
        id: definition.id,
        intervalTicks: definition.intervalTicks,
        speed: definition.speed ?? 100,
        attack: definition,
        start(battle, source) {
            const unit = units.get(battle, source);
            const bindings = chooseTargets(battle, source, definition);
            const target = bindings[definition.triggerBindingId]?.[0];

            if (unit === undefined || target === undefined) {
                return { state: battle, value: null };
            }

            const releaseAtTick = battle.tick + (definition.windupTicks ?? 0);

            return {
                state: battle,
                value: {
                    target,
                    bindings,
                    releaseAtTick,
                    finishAtTick: releaseAtTick + (definition.recoveryTicks ?? 0),
                    released: false,
                    previousReadyAtTick:
                        unit.action.cooldowns.get(definition.id)?.readyAtTick ?? battle.tick,
                    cooldownAdjusted: false,
                    activationId: hasSkill(unit) ? (unit.skill.active?.id ?? null) : null,
                },
            };
        },
        step(battle, self) {
            const identity = ref(self);

            if (!self.state.cooldownAdjusted) {
                const source = units.get(battle, self.source);
                const cooldown = source?.action.cooldowns.get(definition.id);
                const overdue = self.startedAtTick - self.state.previousReadyAtTick;

                if (source !== undefined && cooldown !== undefined && overdue >= 0 && overdue < 1) {
                    battle = updateUnit(battle, {
                        ...source,
                        action: {
                            ...source.action,
                            cooldowns: new Map(source.action.cooldowns).set(definition.id, {
                                ...cooldown,
                                readyAtTick: self.state.previousReadyAtTick + cooldown.periodTicks,
                            }),
                        },
                    });
                }

                self = setState(self, { ...self.state, cooldownAdjusted: true });
                battle = actions.replace(battle, self);
                battle = appendEvents(battle, [
                    {
                        type: "ACTION",
                        sourceUnitId: self.source.id,
                        targetUnitId: self.state.target.id,
                        tick: battle.tick,
                    },
                ]);
            }

            if (!self.state.released && battle.tick >= self.state.releaseAtTick) {
                battle = actions.replace(battle, setState(self, { ...self.state, released: true }));
                const released = beforeRelease(battle, identity);
                battle = released.state;
                const current = actions.get(battle, identity);

                if (current?.status !== "RUNNING" || !sourcePresent(battle, current.source)) {
                    return {
                        state: actions.cancel(battle, identity, "SOURCE_ABSENT"),
                        value: true,
                    };
                }
                if (released.value.type === "INTERRUPT") {
                    const source = units.get(battle, self.source);
                    const cooldown = source?.action.cooldowns.get(definition.id);

                    if (source !== undefined && cooldown !== undefined) {
                        battle = updateUnit(battle, {
                            ...source,
                            action: {
                                ...source.action,
                                cooldowns: new Map(source.action.cooldowns).set(definition.id, {
                                    ...cooldown,
                                    readyAtTick: Math.max(
                                        cooldown.readyAtTick,
                                        battle.tick + released.value.recoveryTicks,
                                    ),
                                }),
                            },
                        });
                    }

                    return { state: actions.cancel(battle, identity, "INTERRUPTED"), value: true };
                }

                battle = gainUnitSkillSp(battle, self.source.id, "ATTACK");
                battle = appendEvents(battle, [
                    {
                        type: "ACTION_RELEASED",
                        executionId: self.id,
                        sourceUnitId: self.source.id,
                        tick: battle.tick,
                        markerId: definition.markerId ?? "normal-attack",
                    },
                ]);

                if (definition.output !== undefined) {
                    battle = definition.output(battle, current);
                } else {
                    for (const group of definition.targetGroups) {
                        for (const operation of group.operations) {
                            for (const target of self.state.bindings[group.id] ?? []) {
                                if (actions.get(battle, identity)?.status !== "RUNNING") {
                                    return { state: battle, value: true };
                                }

                                battle = apply(battle, self.source, target, operation, resources);
                            }
                        }
                    }
                    for (const followUp of definition.followUps ?? []) {
                        for (const target of followUp.receiver.type === "SOURCE"
                            ? [self.source]
                            : (self.state.bindings[followUp.receiver.bindingId] ?? [])) {
                            if (actions.get(battle, identity)?.status !== "RUNNING") {
                                return { state: battle, value: true };
                            }

                            battle = apply(
                                battle,
                                self.source,
                                target,
                                followUp.operation,
                                resources,
                            );
                        }
                    }
                }

                if (actions.get(battle, identity)?.status !== "RUNNING") {
                    return { state: battle, value: true };
                }

                const source = units.get(battle, self.source);

                if (
                    source !== undefined &&
                    hasSkill(source) &&
                    source.skill.active?.id === self.state.activationId
                ) {
                    battle = consumeSkillAmmo(battle, source.id, battle.tick, resources).state;
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

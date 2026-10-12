import type { CombatResources } from "../../core/tactical/battle/resources.js";
import { getUnit, updateUnit } from "../../core/tactical/battle/execution/context.js";
import * as modifier from "../../core/tactical/unit/contribution/value.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import type { Definition } from "../../core/tactical/unit/effect/definition.js";
import * as effects from "../../core/tactical/unit/effect/operations.js";
import { find } from "../../core/tactical/unit/effect/query.js";
import {
    hasAction,
    setBeforeReleaseHook,
    removeBeforeReleaseHook,
    type Action,
} from "../../core/tactical/unit/capability/action/capability.js";
import {
    hasDefense,
    setDefenseContribution,
    removeDefenseContribution,
    setResistanceContribution,
    removeResistanceContribution,
    type Defense,
} from "../../core/tactical/unit/capability/defense/capability.js";
import { ELEMENT_TYPES } from "../../core/tactical/unit/capability/elemental/capability.js";
import type { ElementalBurstContext } from "../../core/tactical/unit/capability/elemental/definition.js";
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
    type Offense,
} from "../../core/tactical/unit/capability/offense/capability.js";
import {
    addStatusContribution,
    removeStatusContribution,
    hasStatus,
    type Status,
    type StatusFlag,
} from "../../core/tactical/unit/capability/status/capability.js";
import { createDamageOperands } from "../../core/tactical/unit/capability/vitality/damage/contract.js";
import { getArknightsElementalBurstProfile } from "./elemental.js";

function statusEffect(id: string, flags: readonly StatusFlag[]): Definition<object, Status> {
    return {
        id,
        initialize: () => ({}),
        onEnable: (context) => {
            const unit = context.unit;
            updateUnit(context.battle, {
                ...unit,
                status: addStatusContribution(unit.status, {
                    id: `@effect/${context.self.id}/status`,
                    flags,
                }),
            });
        },
        onDisable: (context) => {
            const unit = context.unit;
            updateUnit(context.battle, {
                ...unit,
                status: removeStatusContribution(unit.status, `@effect/${context.self.id}/status`),
            });
        },
    };
}

export function registerArknightsElementalBursts(resources: CombatResources): void {
    const paralysisStun = statusEffect("elemental/paralysis-stun", ["STUNNED"]);

    for (const receiver of ["CHARACTER", "ENEMY"] as const) {
        for (const type of ELEMENT_TYPES) {
            const profile = getArknightsElementalBurstProfile(receiver, type);
            const prefix = `elemental/${receiver}/${type}`;
            const reduction: Definition<{ defense: number; resistance: number }, Defense> = {
                id: `${prefix}/defense`,
                initialize: () => ({
                    defense: profile.defReduction,
                    resistance: profile.resReduction,
                }),
                onEnable: (context) => {
                    if (profile.defReduction !== 0) {
                        updateUnit(
                            context.battle,
                            setDefenseContribution(context.unit, {
                                id: `@effect/${context.self.id}/defense`,
                                value: [modifier.create({ addition: -context.self.state.defense })],
                            }),
                        );
                    }
                    if (profile.resReduction !== 0) {
                        updateUnit(
                            context.battle,
                            setResistanceContribution(context.unit, {
                                id: `@effect/${context.self.id}/resistance`,
                                value: [
                                    modifier.create({ addition: -context.self.state.resistance }),
                                ],
                            }),
                        );
                    }
                },
                onDisable: (context) => {
                    updateUnit(
                        context.battle,
                        removeDefenseContribution(
                            context.unit,
                            `@effect/${context.self.id}/defense`,
                        ),
                    );
                    updateUnit(
                        context.battle,
                        removeResistanceContribution(
                            context.unit,
                            `@effect/${context.self.id}/resistance`,
                        ),
                    );
                },
            };
            const flags: StatusFlag[] = [];

            if (profile.stunTicks > 0) {
                flags.push("STUNNED");
            }
            if (profile.blocksSkill) {
                flags.push("SILENCED");
            }
            if (profile.blocksSpRecovery) {
                flags.push("SP_RECOVERY_BLOCKED");
            }

            const status = statusEffect(`${prefix}/status`, flags);
            const weakness: Definition<{ scaler: number }, Offense> = {
                id: `${prefix}/weakness`,
                initialize: () => ({ scaler: 1 - profile.attackReductionRatio }),
                onEnable: (context) => {
                    updateUnit(
                        context.battle,
                        setAttackContribution(context.unit, {
                            id: `@effect/${context.self.id}/attack`,
                            value: [modifier.create({ finalScaler: context.self.state.scaler })],
                        }),
                    );
                },
                onDisable: (context) => {
                    updateUnit(
                        context.battle,
                        removeAttackContribution(context.unit, `@effect/${context.self.id}/attack`),
                    );
                },
            };
            const paralysis: Definition<{ remaining: number }, Action> = {
                id: `${prefix}/paralysis`,
                initialize: () => ({ remaining: profile.paralysisStacks }),
                onInstall: (context) => {
                    const effectId = context.self.id;
                    updateUnit(
                        context.battle,
                        setBeforeReleaseHook(context.unit, {
                            id: `@effect/${effectId}/paralysis`,
                            enabled: (context) => {
                                const current = find(context.unit, paralysis, effectId);

                                return current?.status === "ACTIVE" && current.state.remaining > 0;
                            },
                            invoke: (context) => {
                                const self = find(context.unit, paralysis, effectId)!;
                                const ref = {
                                    type: "EFFECT" as const,
                                    unitId: context.unit.id,
                                    effectId,
                                };
                                const remaining = self.state.remaining - 1;
                                effects.setState(context.battle, ref, paralysis, { remaining });

                                if (remaining === 0) {
                                    effects.end(context.battle, ref);
                                }

                                const recoveryTicks = TICKS_PER_SECOND / 2;

                                if (hasStatus(context.unit)) {
                                    effects.install(context.battle, context.unit, paralysisStun, {
                                        source: null,
                                        scopes: [
                                            { type: "TICK", tick: context.tick + recoveryTicks },
                                        ],
                                    });
                                }

                                return { type: "INTERRUPT", recoveryTicks };
                            },
                        }),
                    );
                },
                onEnd: (context) => {
                    updateUnit(
                        context.battle,
                        removeBeforeReleaseHook(
                            context.unit,
                            `@effect/${context.self.id}/paralysis`,
                        ),
                    );
                },
            };

            const hurt = (
                context: ElementalBurstContext,
                damage: NonNullable<typeof profile.burstDamage>,
                ignoreForSp: boolean,
            ): void => {
                context.damage({
                    sourceUnitId: null,
                    targetUnitId: context.burst.targetUnitId,
                    damageType: damage.type,
                    operands: createDamageOperands(damage.power),
                    ignoreForSp,
                });
            };

            resources.elemental.register(receiver, type, {
                begin: (context) => {
                    const unitId = context.burst.targetUnitId;
                    const unit = context.facts.getUnit(unitId);

                    if (unit === undefined) {
                        return;
                    }

                    const input = {
                        source: null,
                        scopes: [{ type: "TICK" as const, tick: context.burst.endsAtTick }],
                    };

                    if (
                        hasDefense(unit) &&
                        (profile.defReduction !== 0 || profile.resReduction !== 0)
                    ) {
                        effects.install(context.battle, unit, reduction, {
                            ...input,
                            scopes: profile.defReduction > 0 ? [] : input.scopes,
                        });
                    }
                    if (hasStatus(unit) && flags.length > 0) {
                        effects.install(context.battle, unit, status, input);
                    }
                    if (hasOffense(unit) && profile.attackReductionRatio > 0) {
                        effects.install(context.battle, unit, weakness, input);
                    }
                    if (profile.paralysisStacks > 0 && hasAction(unit)) {
                        effects.install(context.battle, unit, paralysis, {
                            ...input,
                            scopes: [],
                        });
                    }
                    if (profile.burstDamage !== null) {
                        hurt(context, profile.burstDamage, false);
                    }
                },
                advance: (context) => {
                    const end = Math.min(context.tick, context.burst.endsAtTick);
                    const completedSeconds = Math.floor(
                        (end - context.burst.startedAtTick) / TICKS_PER_SECOND,
                    );
                    const previousSeconds = Math.floor(
                        (context.previousTick - context.burst.startedAtTick) / TICKS_PER_SECOND,
                    );

                    for (let second = previousSeconds + 1; second <= completedSeconds; second++) {
                        if (profile.spDrainPerSecond > 0) {
                            context.drainSp(profile.spDrainPerSecond);
                        }
                        if (profile.damagePerSecond !== null) {
                            hurt(context, profile.damagePerSecond, true);
                        }

                        const unit = context.facts.getUnit(context.burst.targetUnitId);

                        if (
                            profile.attackReductionRatio > 0 &&
                            unit !== undefined &&
                            hasOffense(unit)
                        ) {
                            const instance = unit.effects.instances.find(
                                (candidate) =>
                                    candidate.definition === weakness &&
                                    candidate.status !== "ENDING" &&
                                    candidate.scopes.some(
                                        (scope) =>
                                            scope.type === "TICK" &&
                                            scope.tick === context.burst.endsAtTick,
                                    ),
                            );

                            if (instance !== undefined) {
                                const durationSeconds =
                                    (context.burst.endsAtTick - context.burst.startedAtTick) /
                                    TICKS_PER_SECOND;
                                const scaler =
                                    1 -
                                    profile.attackReductionRatio *
                                        Math.max(0, 1 - second / durationSeconds);
                                effects.setState(
                                    context.battle,
                                    { type: "EFFECT", unitId: unit.id, effectId: instance.id },
                                    weakness,
                                    { scaler },
                                );

                                if (instance.status === "ACTIVE") {
                                    const current = getUnit(context.battle, unit.id)!;
                                    updateUnit(
                                        context.battle,
                                        setAttackContribution(current, {
                                            id: `@effect/${instance.id}/attack`,
                                            value: [modifier.create({ finalScaler: scaler })],
                                        }),
                                    );
                                }
                            }
                        }
                    }
                },
            });
        }
    }
}

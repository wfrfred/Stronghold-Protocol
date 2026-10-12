import { setData } from "../../core/tactical/unit/effect/effect.js";
import type { CombatResources } from "../../core/tactical/battle/resources.js";
import { getUnit, updateUnit, type BattleState } from "../../core/tactical/battle/state.js";
import { drainUnitSkillSp } from "../../core/tactical/battle/execution/skill-sp.js";
import * as modifier from "../../core/tactical/unit/contribution/value.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import type { Definition } from "../../core/tactical/unit/effect/definition.js";
import * as effects from "../../core/tactical/unit/effect/operations.js";
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
        onEnable: (state, context) => {
            const unit = context.unit;

            return updateUnit(state, {
                ...unit,
                status: addStatusContribution(unit.status, {
                    id: `@effect/${context.self.id}/status`,
                    flags,
                }),
            });
        },
        onDisable: (state, context) => {
            const unit = context.unit;

            return updateUnit(state, {
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
                onEnable: (state, context) => {
                    let unit = context.unit;

                    if (profile.defReduction !== 0) {
                        unit = setDefenseContribution(unit, {
                            id: `@effect/${context.self.id}/defense`,
                            value: [modifier.create({ addition: -context.self.data.defense })],
                        });
                    }
                    if (profile.resReduction !== 0) {
                        unit = setResistanceContribution(unit, {
                            id: `@effect/${context.self.id}/resistance`,
                            value: [modifier.create({ addition: -context.self.data.resistance })],
                        });
                    }

                    return updateUnit(state, unit);
                },
                onDisable: (state, context) => {
                    const unit = removeDefenseContribution(
                        context.unit,
                        `@effect/${context.self.id}/defense`,
                    );

                    return updateUnit(
                        state,
                        removeResistanceContribution(unit, `@effect/${context.self.id}/resistance`),
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
                onEnable: (state, context) => {
                    return updateUnit(
                        state,
                        setAttackContribution(context.unit, {
                            id: `@effect/${context.self.id}/attack`,
                            value: [modifier.create({ finalScaler: context.self.data.scaler })],
                        }),
                    );
                },
                onDisable: (state, context) => {
                    return updateUnit(
                        state,
                        removeAttackContribution(context.unit, `@effect/${context.self.id}/attack`),
                    );
                },
            };
            const paralysis: Definition<{ remaining: number }, Action> = {
                id: `${prefix}/paralysis`,
                initialize: () => ({ remaining: profile.paralysisStacks }),
                onInstall: (state, context) => {
                    const effectId = context.self.id;

                    return updateUnit(
                        state,
                        setBeforeReleaseHook(context.unit, {
                            id: `@effect/${effectId}/paralysis`,
                            enabled: (context) => {
                                const current = context.unit.effects.get(effectId, paralysis);

                                return current?.status === "ACTIVE" && current.data.remaining > 0;
                            },
                            invoke: (state, context) => {
                                const self = context.unit.effects.get(effectId, paralysis)!;
                                const ref = {
                                    type: "EFFECT" as const,
                                    unitId: context.unit.id,
                                    effectId,
                                };
                                const remaining = self.data.remaining - 1;
                                state = effects.replaceEffect(
                                    state,
                                    ref,
                                    setData(self, { remaining }),
                                );

                                if (remaining === 0) {
                                    state = effects.end(state, ref, "EXPLICIT", context.call);
                                }

                                const recoveryTicks = TICKS_PER_SECOND / 2;

                                const current = getUnit(state, context.unit.id);

                                if (current !== undefined && hasStatus(current)) {
                                    state = effects.install(
                                        state,
                                        current,
                                        paralysisStun,
                                        {
                                            source: null,
                                            scopes: [
                                                {
                                                    type: "TICK",
                                                    tick: context.tick + recoveryTicks,
                                                },
                                            ],
                                        },
                                        context.call,
                                    ).state;
                                }

                                return { state, value: { type: "INTERRUPT", recoveryTicks } };
                            },
                        }),
                    );
                },
                onEnd: (state, context) => {
                    return updateUnit(
                        state,
                        removeBeforeReleaseHook(
                            context.unit,
                            `@effect/${context.self.id}/paralysis`,
                        ),
                    );
                },
            };

            const hurt = (
                state: BattleState,
                context: ElementalBurstContext,
                damage: NonNullable<typeof profile.burstDamage>,
                ignoreForSp: boolean,
            ): BattleState => {
                return resources.settleDamage(
                    state,
                    {
                        sourceUnitId: null,
                        targetUnitId: context.burst.targetUnitId,
                        damageType: damage.type,
                        operands: createDamageOperands(damage.power),
                        ignoreForSp,
                        tick: context.tick,
                    },
                    context.call,
                ).state;
            };

            resources.elemental.register(receiver, type, {
                begin: (state, context) => {
                    const unitId = context.burst.targetUnitId;
                    let unit = getUnit(state, unitId);

                    if (unit === undefined) {
                        return state;
                    }

                    const input = {
                        source: null,
                        scopes: [{ type: "TICK" as const, tick: context.burst.endsAtTick }],
                    };

                    if (
                        hasDefense(unit) &&
                        (profile.defReduction !== 0 || profile.resReduction !== 0)
                    ) {
                        state = effects.install(
                            state,
                            unit,
                            reduction,
                            {
                                ...input,
                                scopes: profile.defReduction > 0 ? [] : input.scopes,
                            },
                            context.call,
                        ).state;
                        unit = getUnit(state, unitId);
                    }

                    if (unit === undefined) {
                        return state;
                    }
                    if (hasStatus(unit) && flags.length > 0) {
                        state = effects.install(state, unit, status, input, context.call).state;
                        unit = getUnit(state, unitId);
                    }
                    if (
                        unit !== undefined &&
                        hasOffense(unit) &&
                        profile.attackReductionRatio > 0
                    ) {
                        state = effects.install(state, unit, weakness, input, context.call).state;
                        unit = getUnit(state, unitId);
                    }
                    if (unit !== undefined && profile.paralysisStacks > 0 && hasAction(unit)) {
                        state = effects.install(
                            state,
                            unit,
                            paralysis,
                            {
                                ...input,
                                scopes: [],
                            },
                            context.call,
                        ).state;
                    }
                    if (profile.burstDamage !== null) {
                        state = hurt(state, context, profile.burstDamage, false);
                    }

                    return state;
                },
                advance: (state, context) => {
                    const end = Math.min(context.tick, context.burst.endsAtTick);
                    const completedSeconds = Math.floor(
                        (end - context.burst.startedAtTick) / TICKS_PER_SECOND,
                    );
                    const previousSeconds = Math.floor(
                        (context.previousTick - context.burst.startedAtTick) / TICKS_PER_SECOND,
                    );

                    for (let second = previousSeconds + 1; second <= completedSeconds; second++) {
                        if (profile.spDrainPerSecond > 0) {
                            state = drainUnitSkillSp(
                                state,
                                context.burst.targetUnitId,
                                profile.spDrainPerSecond,
                            ).state;
                        }
                        if (profile.damagePerSecond !== null) {
                            state = hurt(state, context, profile.damagePerSecond, true);
                        }

                        const unit = getUnit(state, context.burst.targetUnitId);

                        if (
                            profile.attackReductionRatio > 0 &&
                            unit !== undefined &&
                            hasOffense(unit)
                        ) {
                            const instance = unit.effects
                                .values()
                                .find(
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
                                const typed = unit.effects.get(instance.id, weakness)!;
                                state = effects.replaceEffect(
                                    state,
                                    { type: "EFFECT", unitId: unit.id, effectId: typed.id },
                                    setData(typed, { scaler }),
                                );

                                if (instance.status === "ACTIVE") {
                                    const current = getUnit(state, unit.id)!;
                                    state = updateUnit(
                                        state,
                                        setAttackContribution(current, {
                                            id: `@effect/${instance.id}/attack`,
                                            value: [modifier.create({ finalScaler: scaler })],
                                        }),
                                    );
                                }
                            }
                        }
                    }

                    return state;
                },
            });
        }
    }
}

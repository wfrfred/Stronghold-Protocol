import { resolveDamage } from "../../core/tactical/unit/capability/vitality/damage/settlement.js";
import { ref as unitRef } from "../../core/tactical/unit/query.js";
import { ref as effectRef, setData } from "../../core/tactical/unit/effect/effect.js";
import type { CombatResources } from "../../core/tactical/battle/resources.js";
import {
    getUnit,
    updateUnit,
    type State as BattleState,
} from "../../core/tactical/battle/state.js";
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
import type { ElementalBurstContext } from "../../core/tactical/unit/capability/elemental/burst-definition.js";
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
    type Offense,
} from "../../core/tactical/unit/capability/offense/capability.js";
import { stun } from "../../content/tactical/effects/stun.js";
import { silence, blockSpRecovery } from "../../content/tactical/effects/control.js";
import { createDamageOperands } from "../../core/tactical/unit/capability/vitality/damage/contract.js";
import { getArknightsElementalBurstProfile } from "./elemental.js";

export function registerArknightsElementalBursts(resources: CombatResources): void {
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
                    let defense = context.unit.defense;

                    if (profile.defReduction !== 0) {
                        defense = setDefenseContribution(defense, {
                            id: `@effect/${context.self.id}/defense`,
                            value: [modifier.create({ addition: -context.self.data.defense })],
                        });
                    }
                    if (profile.resReduction !== 0) {
                        defense = setResistanceContribution(defense, {
                            id: `@effect/${context.self.id}/resistance`,
                            value: [modifier.create({ addition: -context.self.data.resistance })],
                        });
                    }

                    return defense === context.unit.defense
                        ? state
                        : updateUnit(state, { ...context.unit, defense });
                },
                onDisable: (state, context) => {
                    const withoutDefense = removeDefenseContribution(
                        context.unit.defense,
                        `@effect/${context.self.id}/defense`,
                    );
                    const defense = removeResistanceContribution(
                        withoutDefense,
                        `@effect/${context.self.id}/resistance`,
                    );

                    return defense === context.unit.defense
                        ? state
                        : updateUnit(state, { ...context.unit, defense });
                },
            };
            const controls: Definition<object>[] = [
                ...(profile.stunTicks > 0 ? [stun] : []),
                ...(profile.blocksSkill ? [silence] : []),
                ...(profile.blocksSpRecovery ? [blockSpRecovery] : []),
            ];
            const weakness: Definition<{ scaler: number }, Offense> = {
                id: `${prefix}/weakness`,
                initialize: () => ({ scaler: 1 - profile.attackReductionRatio }),
                onEnable: (state, context) => {
                    return updateUnit(state, {
                        ...context.unit,
                        offense: setAttackContribution(context.unit.offense, {
                            id: `@effect/${context.self.id}/attack`,
                            value: [modifier.create({ finalScaler: context.self.data.scaler })],
                        }),
                    });
                },
                onDisable: (state, context) => {
                    return updateUnit(state, {
                        ...context.unit,
                        offense: removeAttackContribution(
                            context.unit.offense,
                            `@effect/${context.self.id}/attack`,
                        ),
                    });
                },
            };
            const paralysis: Definition<{ remaining: number }, Action> = {
                id: `${prefix}/paralysis`,
                initialize: () => ({ remaining: profile.paralysisStacks }),
                onInstall: (state, context) => {
                    const effectId = context.self.id;

                    return updateUnit(state, {
                        ...context.unit,
                        action: setBeforeReleaseHook(context.unit.action, {
                            id: `@effect/${effectId}/paralysis`,
                            enabled: (context) => {
                                const current = context.unit.effects.get(effectId, paralysis);

                                return current?.status === "ACTIVE" && current.data.remaining > 0;
                            },
                            invoke: (state, context) => {
                                const self = context.unit.effects.get(effectId, paralysis)!;
                                const ref = effectRef(self);
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

                                if (current !== undefined) {
                                    state = effects.install(
                                        state,
                                        unitRef(current),
                                        stun,
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
                    });
                },
                onEnd: (state, context) => {
                    return updateUnit(state, {
                        ...context.unit,
                        action: removeBeforeReleaseHook(
                            context.unit.action,
                            `@effect/${context.self.id}/paralysis`,
                        ),
                    });
                },
            };

            const hurt = (
                state: BattleState,
                context: ElementalBurstContext,
                damage: NonNullable<typeof profile.burstDamage>,
                ignoreForSp: boolean,
            ): BattleState => {
                return resolveDamage(
                    state,
                    {
                        sourceUnitId: null,
                        targetUnitId: context.burst.targetUnitId,
                        damageType: damage.type,
                        operands: createDamageOperands(damage.power),
                        ignoreForSp,
                        tick: context.tick,
                    },
                    resources,
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
                            unitRef(unit),
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
                    for (const control of controls) {
                        unit = getUnit(state, unitId);

                        if (unit === undefined) {
                            return state;
                        }

                        state = effects.install(
                            state,
                            unitRef(unit),
                            control,
                            input,
                            context.call,
                        ).state;
                    }

                    unit = getUnit(state, unitId);

                    if (
                        unit !== undefined &&
                        hasOffense(unit) &&
                        profile.attackReductionRatio > 0
                    ) {
                        state = effects.install(
                            state,
                            unitRef(unit),
                            weakness,
                            input,
                            context.call,
                        ).state;
                        unit = getUnit(state, unitId);
                    }
                    if (unit !== undefined && profile.paralysisStacks > 0 && hasAction(unit)) {
                        state = effects.install(
                            state,
                            unitRef(unit),
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
                                    effectRef(typed),
                                    setData(typed, { scaler }),
                                );

                                if (instance.status === "ACTIVE") {
                                    const current = getUnit(state, unit.id);

                                    if (current !== undefined && hasOffense(current)) {
                                        state = updateUnit(state, {
                                            ...current,
                                            offense: setAttackContribution(current.offense, {
                                                id: `@effect/${instance.id}/attack`,
                                                value: [modifier.create({ finalScaler: scaler })],
                                            }),
                                        });
                                    }
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

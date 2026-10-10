import type { CombatResources } from "../../core/tactical/battle/resources.js";
import * as modifier from "../../core/tactical/modifier/value.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import { hasEffects } from "../../core/tactical/unit/capability/effects/capability.js";
import { createEffectProgram } from "../../core/tactical/unit/capability/effects/program.js";
import { defense, resistance } from "../../core/tactical/unit/capability/defense/contributions.js";
import { hasDefense } from "../../core/tactical/unit/capability/defense/capability.js";
import { ELEMENT_TYPES } from "../../core/tactical/unit/capability/elemental/capability.js";
import type { ElementalBurstContext } from "../../core/tactical/unit/capability/elemental/program.js";
import { attack } from "../../core/tactical/unit/capability/offense/contributions.js";
import { hasOffense } from "../../core/tactical/unit/capability/offense/capability.js";
import {
    hasStatus,
    type StatusFlag,
} from "../../core/tactical/unit/capability/status/capability.js";
import { compileStatusBinding } from "../../core/tactical/unit/capability/status/binding.js";
import { createDamageOperands } from "../../core/tactical/unit/capability/vitality/damage/contract.js";
import { getArknightsElementalBurstProfile } from "./elemental.js";

export function registerArknightsElementalBursts(resources: CombatResources): void {
    const paralysisStun = resources.registerEffect(
        createEffectProgram({
            id: "elemental/paralysis-stun",
            initialize: () => ({}),
        }),
        { bindings: [compileStatusBinding(["STUNNED"])] },
    );

    for (const receiver of ["CHARACTER", "ENEMY"] as const) {
        for (const type of ELEMENT_TYPES) {
            const profile = getArknightsElementalBurstProfile(receiver, type);
            const prefix = `elemental/${receiver}/${type}`;
            const reduction = resources.registerEffect(
                createEffectProgram({
                    id: `${prefix}/defense`,
                    initialize: () => ({
                        defense: profile.defReduction,
                        resistance: profile.resReduction,
                    }),
                }),
                {
                    contributions: [
                        ...(profile.defReduction === 0
                            ? []
                            : [
                                  defense<{ defense: number; resistance: number }>((instance) => [
                                      modifier.create({ addition: -instance.state.defense }),
                                  ]),
                              ]),
                        ...(profile.resReduction === 0
                            ? []
                            : [
                                  resistance<{ defense: number; resistance: number }>(
                                      (instance) => [
                                          modifier.create({ addition: -instance.state.resistance }),
                                      ],
                                  ),
                              ]),
                    ],
                },
            );
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

            const status = resources.registerEffect(
                createEffectProgram({
                    id: `${prefix}/status`,
                    initialize: () => ({}),
                }),
                { bindings: flags.length === 0 ? [] : [compileStatusBinding(flags)] },
            );
            const weakness = resources.registerEffect(
                createEffectProgram({
                    id: `${prefix}/weakness`,
                    initialize: () => ({ scaler: 1 - profile.attackReductionRatio }),
                }),
                {
                    contributions:
                        profile.attackReductionRatio === 0
                            ? []
                            : [
                                  attack<{ scaler: number }>((instance) => [
                                      modifier.create({ finalScaler: instance.state.scaler }),
                                  ]),
                              ],
                },
            );
            const paralysis = resources.registerEffect(
                createEffectProgram({
                    id: `${prefix}/paralysis`,
                    initialize: () => ({ remaining: profile.paralysisStacks }),
                }),
                {
                    action: {
                        beforeRelease: (context) => {
                            if (context.instance.state.remaining <= 0) {
                                return { type: "CONTINUE" };
                            }

                            const remaining = context.instance.state.remaining - 1;
                            context.effects.update(context.ref, paralysis.ref, (state) => ({
                                ...state,
                                remaining,
                            }));

                            if (remaining === 0) {
                                context.effects.finish([context.ref]);
                            }

                            const target = context.facts.getUnit(context.unitId);
                            const recoveryTicks = TICKS_PER_SECOND / 2;

                            if (target !== undefined && hasStatus(target)) {
                                context.effects.install(context.unitId, paralysisStun.ref, {
                                    source: null,
                                    scopes: [{ type: "TICK", tick: context.tick + recoveryTicks }],
                                });
                            }

                            return { type: "INTERRUPT", recoveryTicks };
                        },
                    },
                },
            );

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
                        context.effects.install(unitId, reduction.ref, {
                            ...input,
                            scopes: profile.defReduction > 0 ? [] : input.scopes,
                        });
                    }
                    if (hasStatus(unit) && flags.length > 0) {
                        context.effects.install(unitId, status.ref, input);
                    }
                    if (hasOffense(unit) && profile.attackReductionRatio > 0) {
                        context.effects.install(unitId, weakness.ref, input);
                    }
                    if (profile.paralysisStacks > 0) {
                        context.effects.install(unitId, paralysis.ref, {
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
                            hasEffects(unit)
                        ) {
                            const instance = unit.effects.instances.find(
                                (candidate) =>
                                    candidate.programRef.id === weakness.ref.id &&
                                    !candidate.finished &&
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
                                context.effects.update(
                                    { type: "EFFECT", unitId: unit.id, effectId: instance.id },
                                    weakness.ref,
                                    () => ({ scaler }),
                                );
                            }
                        }
                    }
                },
            });
        }
    }
}

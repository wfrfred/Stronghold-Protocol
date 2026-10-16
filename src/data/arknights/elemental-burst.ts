import type { Ref } from "../../core/common/ref.js";
import { updateUnit, type State as BattleState } from "../../core/tactical/battle/state.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";
import * as units from "../../core/tactical/unit/query.js";
import { ref as effectRef, setData } from "../../core/tactical/unit/effect/effect.js";
import type { Definition as EffectDefinition } from "../../core/tactical/unit/effect/definition.js";
import * as effects from "../../core/tactical/unit/effect/operations.js";
import {
    ref as burstRef,
    type Burst,
    type Definition,
} from "../../core/tactical/unit/capability/elemental/burst.js";
import type { Elemental } from "../../core/tactical/unit/capability/elemental/capability.js";
import {
    available,
    get as getBurst,
    resolveBurstRecoverySpeed,
} from "../../core/tactical/unit/capability/elemental/query.js";
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
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
} from "../../core/tactical/unit/capability/offense/capability.js";
import { hasSkill } from "../../core/tactical/unit/capability/skill/capability.js";
import { modify } from "../../core/tactical/unit/capability/skill/sp.js";
import type { DamageRequest } from "../../core/tactical/battle/damage/contract.js";
import { calculateDamage } from "../../core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../core/tactical/battle/damage/apply.js";
import { hasVitality } from "../../core/tactical/unit/capability/vitality/capability.js";
import * as attribute from "../../core/tactical/unit/contribution/attribute.js";
import { stun } from "../../content/tactical/effects/stun.js";
import { silence, blockSpRecovery } from "../../content/tactical/effects/control.js";
import type { ArknightsElementalBurstProfile } from "./elemental.js";

interface Clock {
    readonly elapsedTicks: number;
    readonly lastAdvancedTick: number;
    readonly scaler: number;
}

export function create(id: string, profile: ArknightsElementalBurstProfile): Definition {
    const reduction: EffectDefinition<{ defense: number; resistance: number }, Defense> = {
        id: `${id}/defense`,
        initialize: () => ({
            defense: profile.defReduction,
            resistance: profile.resReduction,
        }),
        onEnable: (battle, { unit, self }) => {
            let defense = unit.defense;

            if (self.data.defense !== 0) {
                defense = setDefenseContribution(defense, {
                    id: `@effect/${self.id}/defense`,
                    value: [attribute.create({ addition: -self.data.defense })],
                });
            }
            if (self.data.resistance !== 0) {
                defense = setResistanceContribution(defense, {
                    id: `@effect/${self.id}/resistance`,
                    value: [attribute.create({ addition: -self.data.resistance })],
                });
            }

            return defense === unit.defense ? battle : updateUnit(battle, { ...unit, defense });
        },
        onDisable: (battle, { unit, self }) => {
            const defense = removeResistanceContribution(
                removeDefenseContribution(unit.defense, `@effect/${self.id}/defense`),
                `@effect/${self.id}/resistance`,
            );

            return defense === unit.defense ? battle : updateUnit(battle, { ...unit, defense });
        },
    };
    const paralysis: EffectDefinition<{ remaining: number }, Action> = {
        id: `${id}/paralysis`,
        initialize: () => ({ remaining: profile.paralysisStacks }),
        onInstall: (battle, { unit, self }) => {
            const effectId = self.id;

            return updateUnit(battle, {
                ...unit,
                action: setBeforeReleaseHook(unit.action, {
                    id: `@effect/${effectId}/paralysis`,
                    accepts: (battle, context) => {
                        const current = units
                            .get(battle, context.source)
                            ?.effects.get(effectId, paralysis);

                        return current?.status === "ACTIVE" && current.data.remaining > 0;
                    },
                    invoke: (battle, context) => {
                        const self = units
                            .get(battle, context.source)!
                            .effects.get(effectId, paralysis)!;
                        const ref = effectRef(self);
                        const remaining = self.data.remaining - 1;
                        battle = effects.replaceEffect(battle, ref, setData(self, { remaining }));

                        if (remaining === 0) {
                            battle = effects.end(battle, ref, "EXPLICIT");
                        }

                        const recoveryTicks = TICKS_PER_SECOND / 2;
                        const current = units.get(battle, self.host);

                        if (current?.lifecycle === "PRESENT") {
                            battle = effects.install(battle, self.host, stun, {
                                scopes: [{ type: "TICK", tick: battle.tick + recoveryTicks }],
                            }).state;
                        }

                        return { state: battle, value: { type: "INTERRUPT", recoveryTicks } };
                    },
                }),
            });
        },
        onEnd: (battle, { unit, self }) =>
            updateUnit(battle, {
                ...unit,
                action: removeBeforeReleaseHook(unit.action, `@effect/${self.id}/paralysis`),
            }),
    };
    const periodic: EffectDefinition<Clock, Elemental> = {
        id: `${id}/periodic`,
        initialize: () => ({
            elapsedTicks: 0,
            lastAdvancedTick: 0,
            scaler: 1 - profile.attackReductionRatio,
        }),
        onEnable: (battle, { unit, self }) =>
            profile.attackReductionRatio > 0 && hasOffense(unit)
                ? updateUnit(battle, {
                      ...unit,
                      offense: setAttackContribution(unit.offense, {
                          id: `@effect/${self.id}/attack`,
                          value: [attribute.create({ finalScaler: self.data.scaler })],
                      }),
                  })
                : battle,
        onDisable: (battle, { unit, self }) =>
            profile.attackReductionRatio > 0 && hasOffense(unit)
                ? updateUnit(battle, {
                      ...unit,
                      offense: removeAttackContribution(unit.offense, `@effect/${self.id}/attack`),
                  })
                : battle,
        onTick: (battle, { self, ref }) => {
            const scope = self.scopes.find((scope) => scope.type === "ELEMENTAL_BURST");

            if (scope === undefined || getBurst(battle, scope.ref)?.status !== "ACTIVE") {
                return battle;
            }

            const rate =
                activeHost(battle, scope.ref) === undefined
                    ? 0
                    : resolveBurstRecoverySpeed(battle, self.host)!;
            const elapsedTicks = Math.min(
                profile.durationTicks,
                self.data.elapsedTicks + (battle.tick - self.data.lastAdvancedTick) * rate,
            );
            const previousSecond = Math.floor((self.data.elapsedTicks + 1e-8) / TICKS_PER_SECOND);
            const currentSecond = Math.floor((elapsedTicks + 1e-8) / TICKS_PER_SECOND);
            battle = effects.replaceEffect(
                battle,
                ref,
                setData(self, { ...self.data, elapsedTicks, lastAdvancedTick: battle.tick }),
            );

            for (let second = previousSecond + 1; second <= currentSecond; second++) {
                let unit = activeHost(battle, scope.ref);

                if (unit === undefined || effects.get(battle, ref)?.status !== "ACTIVE") {
                    return battle;
                }
                if (profile.spDrainPerSecond > 0 && hasSkill(unit)) {
                    battle = modify(battle, units.ref(unit), -profile.spDrainPerSecond).state;
                }

                unit = activeHost(battle, scope.ref);

                if (unit === undefined || effects.get(battle, ref)?.status !== "ACTIVE") {
                    return battle;
                }
                if (profile.damagePerSecond !== null) {
                    battle = hurt(battle, scope.ref, profile.damagePerSecond);
                }

                unit = activeHost(battle, scope.ref);
                const current = effects.get(battle, ref);

                if (unit === undefined || current?.status !== "ACTIVE") {
                    return battle;
                }
                if (profile.attackReductionRatio > 0 && hasOffense(unit)) {
                    const durationSeconds = profile.durationTicks / TICKS_PER_SECOND;
                    const scaler =
                        1 -
                        profile.attackReductionRatio * Math.max(0, 1 - second / durationSeconds);
                    battle = effects.replaceEffect(
                        battle,
                        ref,
                        setData(current, { ...current.data, scaler }),
                    );
                    const host = activeHost(battle, scope.ref)!;

                    if (!hasOffense(host)) {
                        return battle;
                    }

                    battle = updateUnit(battle, {
                        ...host,
                        offense: setAttackContribution(host.offense, {
                            id: `@effect/${self.id}/attack`,
                            value: [attribute.create({ finalScaler: scaler })],
                        }),
                    });
                }
            }

            return battle;
        },
    };
    const controls: readonly EffectDefinition<object>[] = [
        ...(profile.stunTicks > 0 ? [stun] : []),
        ...(profile.blocksSkill ? [silence] : []),
        ...(profile.blocksSpRecovery ? [blockSpRecovery] : []),
    ];

    return Object.freeze({
        durationTicks: profile.durationTicks,
        onStart: (battle: BattleState, self: Burst): BattleState => {
            const ref = burstRef(self);
            const scopes = [{ type: "ELEMENTAL_BURST" as const, ref }];
            let unit = activeHost(battle, ref);

            if (unit === undefined) {
                return battle;
            }
            if (hasDefense(unit) && (profile.defReduction !== 0 || profile.resReduction !== 0)) {
                battle = effects.install(battle, units.ref(unit), reduction, {
                    scopes: profile.defReduction > 0 ? [] : scopes,
                }).state;
            }

            for (const control of controls) {
                unit = activeHost(battle, ref);

                if (unit === undefined) {
                    return battle;
                }

                battle = effects.install(battle, self.host, control, { scopes }).state;
            }

            unit = activeHost(battle, ref);

            if (unit === undefined) {
                return battle;
            }
            if (
                profile.damagePerSecond !== null ||
                profile.spDrainPerSecond > 0 ||
                profile.attackReductionRatio > 0
            ) {
                battle = effects.install(battle, self.host, periodic, {
                    scopes,
                    data: {
                        elapsedTicks: 0,
                        lastAdvancedTick: battle.tick,
                        scaler: 1 - profile.attackReductionRatio,
                    },
                }).state;
            }

            unit = activeHost(battle, ref);

            if (unit === undefined) {
                return battle;
            }
            if (profile.paralysisStacks > 0 && hasAction(unit)) {
                const existing = unit.effects
                    .values()
                    .find(
                        (effect) => effect.definition === paralysis && effect.status !== "ENDING",
                    );

                if (existing === undefined) {
                    battle = effects.install(battle, units.ref(unit), paralysis).state;
                } else {
                    const current = unit.effects.get(existing.id, paralysis)!;
                    battle = effects.replaceEffect(
                        battle,
                        effectRef(current),
                        setData(current, { remaining: profile.paralysisStacks }),
                    );
                }
            }

            return profile.burstDamage === null ? battle : hurt(battle, ref, profile.burstDamage);
        },
    });
}

function activeHost(battle: BattleState, ref: Ref<Burst>) {
    const host = units.get(battle, ref.host);

    return host !== undefined && available(host) && getBurst(battle, ref)?.status === "ACTIVE"
        ? host
        : undefined;
}

function hurt(
    battle: BattleState,
    ref: Ref<Burst>,
    damage: NonNullable<ArknightsElementalBurstProfile["burstDamage"]>,
): BattleState {
    const host = activeHost(battle, ref);

    if (host === undefined || !hasVitality(host)) {
        return battle;
    }

    const attack = { power: damage.power, multiplier: 1, addition: 0 };
    const type = damage.type;
    const request: DamageRequest = {
        source: null,
        target: units.ref(host),
        parameters:
            type === "PHYSICAL" || type === "ARTS"
                ? { type, attack, penetration: { fixed: 0, proportional: 0 } }
                : { type, attack },
    };

    return applyDamage(request, calculateDamage(battle, request)).state;
}

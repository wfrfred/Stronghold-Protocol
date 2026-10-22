import type { Definition as ElementalDefinition } from "../../../core/tactical/unit/capability/elemental/capability.js";
import type { Definition as OccupancyDefinition } from "../../../core/tactical/unit/capability/occupancy/capability.js";
import {
    hasTargetable,
    type Definition as TargetableDefinition,
} from "../../../core/tactical/unit/capability/targetable/capability.js";
import { createArknightsElementalDefinition } from "../../../data/arknights/elemental.js";
import { Definitions } from "../../../core/tactical/unit/action/definitions.js";
import { clearCooldown, get as getAction } from "../../../core/tactical/unit/action/operations.js";
import { ref as actionRef } from "../../../core/tactical/unit/action/action.js";
import {
    create as createAttack,
    type Attack,
    type Configuration as AttackConfiguration,
} from "../actions/attack.js";
import { create as createSkillAttack, type State as SkillAttackState } from "../actions/skill.js";
import { hasCandidate } from "../../../core/tactical/battle/targeting/select.js";
import * as filters from "../../../core/tactical/battle/targeting/filter.js";
import * as compare from "../../../core/tactical/battle/targeting/compare.js";
import { first } from "../../../core/tactical/battle/targeting/selector.js";
import { calculateHealing } from "../../../core/tactical/battle/healing/calculate.js";
import { applyHealing } from "../../../core/tactical/battle/healing/apply.js";
import type { HealingRequest } from "../../../core/tactical/battle/healing/contract.js";
import { calculateDamage } from "../../../core/tactical/battle/damage/calculate.js";
import { applyDamage } from "../../../core/tactical/battle/damage/apply.js";
import type { DamageRequest } from "../../../core/tactical/battle/damage/contract.js";
import { ref as unitRef } from "../../../core/tactical/unit/query.js";
import type { Profile } from "../../../data/arknights/operator.js";
import { secondsToTicks } from "../../../data/arknights/tick.js";
import { createRng } from "../../../core/common/rng.js";
import {
    battlefieldView,
    getUnit,
    updateUnit,
    type State as BattleState,
} from "../../../core/tactical/battle/state.js";
import { modify } from "../../../core/tactical/unit/capability/skill/sp.js";
import type { Direction } from "../../../core/tactical/geometry/direction.js";
import { fromTiles } from "../../../core/tactical/geometry/range.js";
import type { Unit, Id } from "../../../core/tactical/unit/unit.js";
import type { Definition as OperatorDefinition } from "../../../core/tactical/unit/archetype/operator.js";
import { hasAction } from "../../../core/tactical/unit/capability/action/capability.js";
import type { Definition as OffenseDefinition } from "../../../core/tactical/unit/capability/offense/capability.js";
import {
    createDefinition as createDeployableDefinition,
    type Definition as DeployableDefinition,
} from "../../../core/tactical/unit/capability/deployable/capability.js";
import { resolveAttackPower } from "../../../core/tactical/unit/capability/offense/query.js";
import {
    hasSkill,
    type Definition as SkillDefinition,
} from "../../../core/tactical/unit/capability/skill/capability.js";
import { finish } from "../../../core/tactical/unit/capability/skill/operations.js";
import { stun } from "../effects/stun.js";
import { healFree } from "../effects/protection.js";
import {
    hasVitality,
    resolveMaxHp,
    type Vitality,
} from "../../../core/tactical/unit/capability/vitality/capability.js";
import { removeHook, setHook } from "../../../core/tactical/battle/damage/hook.js";
import type { Definition as EffectDefinition } from "../../../core/tactical/unit/effect/definition.js";
import { setData } from "../../../core/tactical/unit/effect/effect.js";
import { get, install, replaceEffect } from "../../../core/tactical/unit/effect/operations.js";

export interface Definition extends OperatorDefinition {
    readonly elemental: ElementalDefinition;
    readonly deployable: DeployableDefinition;
    readonly occupancy: OccupancyDefinition;
    readonly targetable: TargetableDefinition;
    readonly offense: OffenseDefinition;
    readonly skill: SkillDefinition;
    readonly profile: Profile;
    readonly direction: Direction;
}

interface ShieldState {
    readonly layers: number;
    readonly timer: number;
    readonly lastTick: number;
}

const SHIELD_ID = "mudrock/shield";

export function readShield(
    unit: Unit,
): { readonly layers: number; readonly timer: number } | undefined {
    const effect = unit.effects.values().find((entry) => entry.definition.id === SHIELD_ID);
    const data = effect?.data;

    return effect?.status === "ACTIVE" &&
        data !== undefined &&
        "layers" in data &&
        typeof data.layers === "number" &&
        "timer" in data &&
        typeof data.timer === "number"
        ? { layers: data.layers, timer: data.timer }
        : undefined;
}

function value(entries: Profile["moduleTrait"], key: string): number {
    const entry = entries.find((entry) => entry.key === key);

    if (entry === undefined) {
        throw new TypeError(`Mudrock content requires ${key}`);
    }

    return entry.value;
}

function hasSarkazTag(unit: Unit | undefined): boolean {
    const definition = unit?.definition;

    if (definition === undefined || !("profile" in definition)) {
        return false;
    }

    const profile = definition.profile;

    return (
        typeof profile === "object" &&
        profile !== null &&
        "tags" in profile &&
        Array.isArray(profile.tags) &&
        profile.tags.includes("sarkaz")
    );
}

function healSelf(state: BattleState, unitId: Id, ratio: number): BattleState {
    const unit = getUnit(state, unitId);

    if (unit === undefined || !hasVitality(unit)) {
        return state;
    }

    const maxHp = resolveMaxHp(unit.vitality, unit.definition.vitality);
    const request: HealingRequest = {
        source: unitRef(unit),
        target: unitRef(unit),
        parameters: { power: maxHp * ratio, multiplier: 1 },
    };

    return applyHealing(request, calculateHealing(state, request)).state;
}

function shieldEffect(profile: Profile): EffectDefinition<ShieldState, Vitality> {
    const talent = profile.talents.find((talent) => talent.key === "1");

    if (talent === undefined) {
        throw new TypeError("Mudrock content requires her shield talent");
    }

    const interval = secondsToTicks(value(talent.blackboard, "interval"));
    const initialLayers = value(talent.blackboard, "times");
    const capacity = value(talent.blackboard, "max_times");
    const healRatio = value(talent.blackboard, "hp_ratio");
    const extraSp = talent.blackboard.find((entry) => entry.key === "sp")?.value ?? 0;
    const sarkazResistance =
        profile.talents
            .find((talent) => talent.key === "2")
            ?.blackboard.find((entry) => entry.key === "damage_resistance")?.value ?? 0;
    const blockedDamageScale =
        profile.moduleTrait.find((entry) => entry.key === "damage_scale")?.value ?? 1;

    const definition: EffectDefinition<ShieldState, Vitality> = {
        id: SHIELD_ID,
        initialize: () => ({ layers: initialLayers, timer: interval, lastTick: 0 }),
        onInstall: (state, { self, ref, tick }) =>
            replaceEffect(state, ref, setData(self, { ...self.data, lastTick: tick })),
        onEnable: (state, { unit, ref, self }) =>
            updateUnit(state, {
                ...unit,
                vitality: setHook(unit.vitality, {
                    id: `${SHIELD_ID}/${self.id}`,
                    stage: "receiving",
                    priority: 100,
                    accepts: () => true,
                    invoke(state, context, pending) {
                        const shield = get(state, ref);

                        if (
                            pending.cancellation !== null ||
                            pending.amount <= 0 ||
                            shield?.status !== "ACTIVE"
                        ) {
                            return { state, value: pending };
                        }
                        if (shield.data.layers > 0) {
                            state = replaceEffect(
                                state,
                                ref,
                                setData(shield, {
                                    ...shield.data,
                                    layers: shield.data.layers - 1,
                                }),
                            );
                            state = healSelf(state, unit.id, healRatio);
                            const current = getUnit(state, unit.id);

                            if (current !== undefined && hasSkill(current)) {
                                state = modify(state, unitRef(current), extraSp).state;
                            }

                            return {
                                state,
                                value: {
                                    ...pending,
                                    cancellation: {
                                        reason: "MUDROCK_SHIELD",
                                    },
                                },
                            };
                        }

                        const sourceId = context.request.source?.id ?? null;
                        const sarkazScale = hasSarkazTag(
                            sourceId === null ? undefined : getUnit(state, sourceId),
                        )
                            ? 1 - sarkazResistance
                            : 1;
                        const blockingScale =
                            sourceId !== null &&
                            battlefieldView(state).blockedBy(unit.id).includes(sourceId)
                                ? blockedDamageScale
                                : 1;

                        return {
                            state,
                            value: {
                                ...pending,
                                amount: pending.amount * sarkazScale * blockingScale,
                            },
                        };
                    },
                }),
            }),
        onDisable: (state, { unit, self }) =>
            updateUnit(state, {
                ...unit,
                vitality: removeHook(unit.vitality, `${SHIELD_ID}/${self.id}`),
            }),
        onTick(state, { self, ref, tick }) {
            const elapsed = tick - self.data.lastTick;

            if (elapsed <= 0) {
                return state;
            }

            const remaining = self.data.timer - elapsed;
            const pulses = remaining <= 0 ? Math.floor(-remaining / interval) + 1 : 0;

            return replaceEffect(
                state,
                ref,
                setData(self, {
                    layers: Math.min(capacity, self.data.layers + pulses),
                    timer: remaining + pulses * interval,
                    lastTick: tick,
                }),
            );
        },
    };

    return definition;
}

function attackDefinition(
    profile: Profile,
    direction: Direction,
    skill: boolean,
    recoveryTicks: number,
): AttackConfiguration {
    const withinRange = filters.range(
        fromTiles(skill ? profile.skillRange! : profile.range, direction),
    );

    return {
        id: skill ? "mudrock/s2" : "normal-attack",
        speed: profile.attributes.attackSpeed,
        triggerBindingId: "primary",
        intervalTicks: secondsToTicks(profile.attributes.baseAttackTime),
        recoveryTicks,
        followUps: [],
        targetGroups: [
            {
                id: "primary",
                targeting: {
                    purposes: ["DAMAGE"],
                    filter: filters.and(
                        filters.damage,
                        filters.ground,
                        skill ? withinRange : filters.or(withinRange, filters.blocking),
                    ),
                    selector: first(
                        skill ? Number.MAX_SAFE_INTEGER : 1,
                        skill
                            ? compare.distance
                            : compare.combine(compare.blockedFirst, compare.distance),
                    ),
                },
                operations: [
                    {
                        type: "DAMAGE",
                        power: 0,
                        powerSource: "SOURCE_ATTACK",
                        damageType: "PHYSICAL",
                    },
                ],
            },
        ],
    };
}

export function create(
    profile: Profile,
    options: { readonly direction?: Direction; readonly recoveryTicks?: number } = {},
): { readonly definition: Definition; readonly action: Attack<object, SkillAttackState> } {
    if (
        profile.id !== "char_311_mudrok" ||
        profile.skill.definition.id !== "skchr_mudrok_2" ||
        profile.skillRange === null
    ) {
        throw new TypeError("Mudrock content requires her second skill and its range");
    }
    if (
        profile.configuration.module !== undefined &&
        profile.configuration.module.id !== "uniequip_002_mudrok"
    ) {
        throw new TypeError("Mudrock content supports only module X");
    }

    const direction = options.direction ?? "RIGHT";
    const recoveryTicks = options.recoveryTicks ?? 0;

    if (!Number.isSafeInteger(recoveryTicks) || recoveryTicks < 0) {
        throw new RangeError("Mudrock recoveryTicks must be a nonnegative integer");
    }

    const shield = shieldEffect(profile);
    const activeConfiguration = attackDefinition(profile, direction, true, recoveryTicks);
    const normalAttack = createAttack(attackDefinition(profile, direction, false, recoveryTicks));
    const targeting = activeConfiguration.targetGroups[0].targeting;
    const attackScale = value(profile.skill.blackboard, "atk_scale");
    const healRatio = value(profile.skill.blackboard, "hp_ratio");
    const stunChance = value(profile.skill.blackboard, "buff_prob");
    const stunTicks = secondsToTicks(value(profile.skill.blackboard, "stun"));
    const action = createSkillAttack({
        ...activeConfiguration,
        markerId: "mudrock/s2",
        output(state, self) {
            const source = getUnit(state, self.host.id);

            if (source === undefined || !hasSkill(source) || source.skill.active === null) {
                return state;
            }

            const power = resolveAttackPower(source.id, battlefieldView(state))!;
            state = healSelf(state, source.id, healRatio);

            for (const targetRef of self.state.bindings.primary ?? []) {
                if (getAction(state, actionRef(self))?.status !== "RUNNING") {
                    return state;
                }

                const battlefield = battlefieldView(state);
                const currentSource = battlefield.getUnit(source.id);
                const target = battlefield.getUnit(targetRef.id);

                if (currentSource?.lifecycle !== "PRESENT") {
                    return state;
                }

                if (
                    target === undefined ||
                    !hasVitality(target) ||
                    !hasTargetable(target) ||
                    !targeting.filter(
                        state,
                        { ...targeting, source: unitRef(currentSource) },
                        target,
                    )
                ) {
                    continue;
                }

                const request: DamageRequest = {
                    source: unitRef(source),
                    target: unitRef(target),
                    parameters: {
                        type: "PHYSICAL",
                        attack: { power, multiplier: attackScale, addition: 0 },
                        penetration: { fixed: 0, proportional: 0 },
                    },
                };
                state = applyDamage(request, calculateDamage(state, request)).state;
                const rng = createRng(state.execution.rngState);
                const applyStun = rng.chance(stunChance);
                state = { ...state, execution: { ...state.execution, rngState: rng.state() } };
                const survivor = getUnit(state, target.id);

                if (applyStun && survivor !== undefined) {
                    state = install(state, unitRef(survivor), stun, {
                        source: source.id,
                        scopes: [{ type: "TICK", tick: state.tick + stunTicks }],
                    }).state;
                }
            }

            return state;
        },
        onEnd(state, self) {
            return self.state.data.activation === null
                ? state
                : finish(state, self.state.data.activation);
        },
    });
    const skill: SkillDefinition = {
        ...profile.skill.definition,
        activation: {
            ...profile.skill.definition.activation!,
            sustain: { type: "INFINITE" },
            accepts(battle, self) {
                const source = getUnit(battle, self.host.id);

                return (
                    source !== undefined &&
                    hasCandidate(battle, { ...targeting, source: unitRef(source) })
                );
            },
            onStart(state, self) {
                const unit = getUnit(state, self.host.id);

                if (unit === undefined || !hasAction(unit)) {
                    return state;
                }

                state = clearCooldown(state, unitRef(unit), normalAttack.id);
                state = clearCooldown(state, unitRef(unit), action.id);

                return state;
            },
        },
    };
    const definition: Definition = {
        elemental: createArknightsElementalDefinition({ receiver: "CHARACTER" }),
        id: profile.id,
        profile,
        direction,
        occupancy: {},
        targetable: { restrictions: [] },
        deployable: createDeployableDefinition({
            cost: profile.attributes.cost,
            redeployTicks: secondsToTicks(profile.attributes.respawnTime),
            slots: 1,
            buildableType: "MELEE",
            advancedBuildableMask: 1,
        }),
        vitality: {
            maxHp: profile.attributes.maxHp,
            defense: profile.attributes.defense,
            resistance: profile.attributes.resistance,
        },
        offense: { attack: profile.attributes.attack },

        allegiance: { side: "ALLY" },
        layer: { type: "GROUND" },
        hitbox: { shape: { type: "CIRCLE", offset: [0, 0], radius: 0.25 } },
        blocker: {
            capacity: profile.attributes.blockCapacity,
            geometry: { radius: 0.70709997 },
        },
        action: {
            definitions: Definitions.empty().add(normalAttack).add(action),
            select: (battle, self) => ({
                state: battle,
                value: [hasSkill(self) && self.skill.active !== null ? action.id : normalAttack.id],
            }),
        },
        skill,
        onEnter(state, unitId) {
            const unit = getUnit(state, unitId);

            if (unit === undefined || !hasVitality(unit) || !hasTargetable(unit)) {
                return state;
            }

            const host = unitRef(unit);
            state = install(state, host, shield).state;

            return install(state, host, healFree).state;
        },
    };

    return { definition, action };
}

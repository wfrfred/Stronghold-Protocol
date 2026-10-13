import type { Profile } from "../../../data/arknights/operator.js";
import { secondsToTicks } from "../../../data/arknights/tick.js";
import { createRng } from "../../../core/common/rng.js";
import {
    battlefieldView,
    getUnit,
    updateUnit,
    type BattleState,
} from "../../../core/tactical/battle/state.js";
import type { CombatResources } from "../../../core/tactical/battle/resources.js";
import type { CallContext } from "../../../core/tactical/battle/execution/call.js";
import { gainUnitSkillSp } from "../../../core/tactical/battle/execution/skill-sp.js";
import type { Direction } from "../../../core/tactical/geometry/direction.js";
import type { Unit, Id } from "../../../core/tactical/unit/unit.js";
import type { Definition as OperatorDefinition } from "../../../core/tactical/unit/archetype/operator.js";
import {
    hasAction,
    type ActionDefinition,
} from "../../../core/tactical/unit/capability/action/capability.js";
import { compileAction } from "../../../core/tactical/unit/capability/action/compile.js";
import type { CompiledAction } from "../../../core/tactical/unit/capability/action/compiled.js";
import type { CompiledActionSegment } from "../../../core/tactical/unit/capability/action/process.js";
import type { Definition as OffenseDefinition } from "../../../core/tactical/unit/capability/offense/capability.js";
import { resolveAttackPower } from "../../../core/tactical/unit/capability/offense/query.js";
import {
    hasSkill,
    type Definition as SkillDefinition,
} from "../../../core/tactical/unit/capability/skill/capability.js";
import { finishSkill } from "../../../core/tactical/unit/capability/skill/execution.js";
import {
    addStatusContribution,
    hasStatus,
    removeStatusContribution,
    type Status,
} from "../../../core/tactical/unit/capability/status/capability.js";
import {
    hasVitality,
    type Vitality,
} from "../../../core/tactical/unit/capability/vitality/capability.js";
import { resolveMaxHp } from "../../../core/tactical/unit/capability/vitality/query.js";
import {
    removeHook,
    setHook,
} from "../../../core/tactical/unit/capability/vitality/damage/hook.js";
import type { Definition as EffectDefinition } from "../../../core/tactical/unit/effect/definition.js";
import { setData } from "../../../core/tactical/unit/effect/effect.js";
import { get, install, replaceEffect } from "../../../core/tactical/unit/effect/operations.js";
import { compileTargeting } from "../../../core/tactical/unit/targeting/compile.js";

export interface Definition extends OperatorDefinition {
    readonly offense: OffenseDefinition;
    readonly skill: SkillDefinition;
    readonly profile: Profile;
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

function healSelf(
    state: BattleState,
    unitId: Id,
    ratio: number,
    tick: number,
    combat: CombatResources,
    call: CallContext,
): BattleState {
    const maxHp = resolveMaxHp(unitId, battlefieldView(state));

    return maxHp === undefined
        ? state
        : combat.settleHealing(
              state,
              {
                  sourceUnitId: unitId,
                  targetUnitId: unitId,
                  power: maxHp * ratio,
                  ignoreHealFree: true,
                  tick,
              },
              call,
          ).state;
}

function shieldEffect(
    profile: Profile,
    combat: CombatResources,
): EffectDefinition<ShieldState, Vitality> {
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
                    stage: "reception",
                    priority: 100,
                    enabled: () => true,
                    invoke(state, context, pending) {
                        const shield = get(state, ref, definition);

                        if (pending.cancellation !== null || shield?.status !== "ACTIVE") {
                            return { state, value: { value: pending } };
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
                            state = healSelf(
                                state,
                                unit.id,
                                healRatio,
                                context.tick,
                                combat,
                                context.call,
                            );
                            state = gainUnitSkillSp(state, unit.id, "EXTERNAL", extraSp);

                            return {
                                state,
                                value: {
                                    value: {
                                        ...pending,
                                        amount: 0,
                                        cancellation: {
                                            stage: "RECEPTION",
                                            reason: "MUDROCK_SHIELD",
                                        },
                                        consumptions: [
                                            ...pending.consumptions,
                                            {
                                                ownerUnitId: unit.id,
                                                resourceId: SHIELD_ID,
                                                resource: "SHIELD_LAYER",
                                                amount: 1,
                                            },
                                        ],
                                    },
                                },
                            };
                        }

                        const sourceId = context.request.sourceUnitId;
                        const sarkazScale = hasSarkazTag(
                            sourceId === null ? undefined : context.battlefield.getUnit(sourceId),
                        )
                            ? 1 - sarkazResistance
                            : 1;
                        const blockingScale =
                            sourceId !== null &&
                            context.battlefield.blockedBy(unit.id).includes(sourceId)
                                ? blockedDamageScale
                                : 1;

                        return {
                            state,
                            value: {
                                value: {
                                    ...pending,
                                    amount: pending.amount * sarkazScale * blockingScale,
                                },
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

const stun: EffectDefinition<object, Status> = {
    id: "mudrock/skill-stun",
    initialize: () => ({}),
    onEnable: (state, { unit, self }) =>
        updateUnit(state, {
            ...unit,
            status: addStatusContribution(unit.status, {
                id: `mudrock/stun/${self.id}`,
                flags: ["STUNNED"],
            }),
        }),
    onDisable: (state, { unit, self }) =>
        updateUnit(state, {
            ...unit,
            status: removeStatusContribution(unit.status, `mudrock/stun/${self.id}`),
        }),
};

function attackDefinition(
    profile: Profile,
    direction: Direction,
    skill: boolean,
    recoveryTicks: number,
): ActionDefinition {
    return {
        triggerBindingId: "primary",
        baseAttackTimeTicks: secondsToTicks(profile.attributes.baseAttackTime),
        recoveryTicks,
        followUps: [],
        targetGroups: [
            {
                id: "primary",
                targeting: {
                    type: "DAMAGE",
                    scope: {
                        type: "RANGE",
                        geometry: {
                            type: "GRID",
                            offsets: skill ? profile.skillRange! : profile.range,
                            direction,
                        },
                    },
                    canTargetAir: false,
                    includeBlockingRelations: !skill,
                    preferBlockingRelations: !skill,
                    ignoreTargetFree: false,
                    ignoreInvisible: false,
                    maxTargets: skill ? Number.MAX_SAFE_INTEGER : 1,
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
    combat: CombatResources,
    options: { readonly direction?: Direction; readonly recoveryTicks?: number } = {},
): { readonly definition: Definition; readonly action: CompiledAction } {
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

    const shield = shieldEffect(profile, combat);
    const activeAction = attackDefinition(profile, direction, true, recoveryTicks);
    const compiled = compileAction(activeAction, combat);
    const targeting = compileTargeting(activeAction.targetGroups[0].targeting, ["DAMAGE"]);
    const attackScale = value(profile.skill.blackboard, "atk_scale");
    const healRatio = value(profile.skill.blackboard, "hp_ratio");
    const stunChance = value(profile.skill.blackboard, "buff_prob");
    const stunTicks = secondsToTicks(value(profile.skill.blackboard, "stun"));
    const finishOnActionEnd: EffectDefinition<object> = {
        id: "mudrock/skill-attack",
        initialize: () => ({}),
        onEnd: (state, context) =>
            finishSkill(state, context.unit.id, context.tick, combat, context.call),
    };
    const program: CompiledActionSegment[] = [
        { type: "RELEASE", markerId: "mudrock/s2" },
        {
            type: "EXECUTE",
            run(state, context) {
                const source = getUnit(state, context.sourceUnitId);

                if (source === undefined || !hasSkill(source) || source.skill.active === null) {
                    return { state, value: undefined };
                }

                state = install(
                    state,
                    source,
                    finishOnActionEnd,
                    {
                        scopes: [
                            { type: "ACTION", executionId: context.executionId },
                            {
                                type: "SKILL",
                                unitId: source.id,
                                activationId: source.skill.active.id,
                            },
                        ],
                    },
                    context.call,
                ).state;
                const power = resolveAttackPower(source.id, battlefieldView(state))!;
                state = healSelf(state, source.id, healRatio, context.tick, combat, context.call);

                for (const targetId of context.bindings.get("primary") ?? []) {
                    const battlefield = battlefieldView(state);
                    const currentSource = battlefield.getUnit(source.id);
                    const target = battlefield.getUnit(targetId);

                    if (
                        currentSource === undefined ||
                        target === undefined ||
                        !targeting.accepts({ source: currentSource, battlefield }, target)
                    ) {
                        continue;
                    }

                    state = combat.settleDamage(
                        state,
                        {
                            sourceUnitId: source.id,
                            targetUnitId: target.id,
                            damageType: "PHYSICAL",
                            operands: {
                                power,
                                attackScale,
                                attackAddition: 0,
                                fixedPenetration: 0,
                                proportionalPenetration: 0,
                            },
                            tick: context.tick,
                        },
                        context.call,
                    ).state;
                    const rng = createRng(state.execution.rngState);
                    const applyStun = rng.chance(stunChance);
                    state = { ...state, execution: { ...state.execution, rngState: rng.state() } };
                    const survivor = getUnit(state, target.id);

                    if (applyStun && survivor !== undefined && hasStatus(survivor)) {
                        state = install(
                            state,
                            survivor,
                            stun,
                            {
                                source: source.id,
                                scopes: [{ type: "TICK", tick: context.tick + stunTicks }],
                            },
                            context.call,
                        ).state;
                    }
                }

                return { state, value: undefined };
            },
        },
        {
            type: "WAIT",
            resolve: () => ({ type: "FOR_TICKS", ticks: recoveryTicks }),
            allowNewAction: false,
        },
    ];
    const skill = combat.skills.register({
        definition: { ...profile.skill.definition, durationTicks: null, activeAction },
        accepts({ unitId, battlefield }) {
            const source = battlefield.getUnit(unitId);

            return (
                source !== undefined &&
                (compiled.bind({ source, battlefield }).get("primary")?.length ?? 0) > 0
            );
        },
        activate(state, { unitId, tick }) {
            const unit = getUnit(state, unitId);

            if (unit === undefined || !hasAction(unit)) {
                return { state, value: { type: "REJECTED", reason: "host absent" } };
            }

            return {
                state: updateUnit(state, {
                    ...unit,
                    action: {
                        ...unit.action,
                        readyAtTick: tick,
                        recoveryUntilTick: tick,
                    },
                }),
                value: { type: "ACTIVATED" },
            };
        },
    });
    const definition: Definition = {
        id: profile.id,
        profile,
        vitality: { maxHp: profile.attributes.maxHp },
        offense: { attack: profile.attributes.attack },
        defense: { defense: profile.attributes.defense, resistance: profile.attributes.resistance },
        allegiance: { side: "ALLY" },
        spatial: { layer: "GROUND" },
        hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.25 }] } },
        status: { initialFlags: ["HEAL_FREE"] },
        blocker: { capacity: profile.attributes.blockCapacity, geometry: { radius: 0.70709997 } },
        action: {
            attackSpeed: profile.attributes.attackSpeed,
            normalAction: attackDefinition(profile, direction, false, recoveryTicks),
        },
        skill: skill.definition,
        onEnter(state, unitId) {
            const unit = getUnit(state, unitId);

            return unit !== undefined && hasVitality(unit)
                ? install(state, unit, shield).state
                : state;
        },
    };

    return { definition, action: { ...compiled, program } };
}

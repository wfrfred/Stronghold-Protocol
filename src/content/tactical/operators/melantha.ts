import type { Profile } from "../../../data/arknights/operator.js";
import { getUnit, updateUnit } from "../../../core/tactical/battle/state.js";
import type { CombatResources } from "../../../core/tactical/battle/resources.js";
import type { Definition as OperatorDefinition } from "../../../core/tactical/unit/archetype/operator.js";
import type { Definition as SkillDefinition } from "../../../core/tactical/unit/capability/skill/capability.js";
import {
    createDefinition as createDeployableDefinition,
    type Definition as DeployableDefinition,
} from "../../../core/tactical/unit/capability/deployable/capability.js";
import {
    hasOffense,
    setAttackContribution,
    removeAttackContribution,
    type Offense,
} from "../../../core/tactical/unit/capability/offense/capability.js";
import type { Definition as EffectDefinition } from "../../../core/tactical/unit/effect/definition.js";
import { install } from "../../../core/tactical/unit/effect/operations.js";
import { create as modifier } from "../../../core/tactical/unit/contribution/value.js";
import type { Direction } from "../../../core/tactical/geometry/direction.js";
import { secondsToTicks } from "../../../data/arknights/tick.js";

export interface Definition extends OperatorDefinition {
    readonly deployable: DeployableDefinition;
    readonly offense: Offense["definition"]["offense"];
    readonly skill: SkillDefinition;
    readonly profile: Profile;
}

function attackBonus(id: string, amount: number): EffectDefinition<object, Offense> {
    return {
        id,
        initialize: () => ({}),
        onEnable: (state, { unit, self }) =>
            updateUnit(state, {
                ...unit,
                offense: setAttackContribution(unit.offense, {
                    id: `effect/${self.id}/attack`,
                    value: [modifier({ multiplier: amount })],
                }),
            }),
        onDisable: (state, { unit, self }) =>
            updateUnit(state, {
                ...unit,
                offense: removeAttackContribution(unit.offense, `effect/${self.id}/attack`),
            }),
    };
}

export function create(
    profile: Profile,
    combat: CombatResources,
    direction: Direction = "RIGHT",
): Definition {
    if (profile.id !== "char_208_melan" || profile.skill.definition.id !== "skcom_atk_up[1]") {
        throw new TypeError("Melantha content requires her first skill");
    }

    const skillBonus = profile.skill.blackboard.find((entry) => entry.key === "atk")!.value;
    const talentBonus = profile.talents
        .find((talent) => talent.key === "1")
        ?.blackboard.find((entry) => entry.key === "atk")?.value;
    const talent = attackBonus("melantha/attack-talent", talentBonus ?? 0);
    const skillEffect = attackBonus("melantha/attack-up", skillBonus);
    const skill = combat.skills.register({
        definition: profile.skill.definition,
        activate(state, context) {
            const unit = getUnit(state, context.unitId);

            if (unit === undefined || !hasOffense(unit)) {
                return { state, value: { type: "REJECTED", reason: "host absent" } };
            }

            const result = install(
                state,
                unit,
                skillEffect,
                {
                    source: unit.id,
                    scopes: [
                        { type: "SKILL", unitId: unit.id, activationId: context.activationId },
                    ],
                },
                context.call,
            );

            return { state: result.state, value: { type: "ACTIVATED" } };
        },
    });

    return {
        id: profile.id,
        profile,
        deployable: createDeployableDefinition({
            cost: profile.attributes.cost,
            redeployTicks: secondsToTicks(profile.attributes.respawnTime),
            slots: 1,
            buildableType: "MELEE",
            advancedBuildableMask: 1,
        }),
        vitality: { maxHp: profile.attributes.maxHp },
        offense: { attack: profile.attributes.attack },
        defense: {
            defense: profile.attributes.defense,
            resistance: profile.attributes.resistance,
        },
        allegiance: { side: "ALLY" },
        spatial: { layer: "GROUND" },
        hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.25 }] } },
        blocker: { capacity: profile.attributes.blockCapacity, geometry: { radius: 0.70709997 } },
        action: {
            attackSpeed: profile.attributes.attackSpeed,
            normalAction: {
                triggerBindingId: "primary",
                baseAttackTimeTicks: secondsToTicks(profile.attributes.baseAttackTime),
                recoveryTicks: 0,
                followUps: [],
                targetGroups: [
                    {
                        id: "primary",
                        targeting: {
                            type: "DAMAGE",
                            scope: {
                                type: "RANGE",
                                geometry: { type: "GRID", offsets: profile.range, direction },
                            },
                            canTargetAir: false,
                            includeBlockingRelations: true,
                            preferBlockingRelations: true,
                            ignoreTargetFree: false,
                            ignoreInvisible: false,
                            maxTargets: 1,
                        },
                        operations: [
                            {
                                type: "DAMAGE",
                                power: profile.attributes.attack,
                                powerSource: "SOURCE_ATTACK",
                                damageType: "PHYSICAL",
                            },
                        ],
                    },
                ],
            },
        },
        skill: skill.definition,
        onEnter(state, unitId) {
            const unit = getUnit(state, unitId);

            return talentBonus !== undefined && unit !== undefined && hasOffense(unit)
                ? install(state, unit, talent).state
                : state;
        },
    };
}

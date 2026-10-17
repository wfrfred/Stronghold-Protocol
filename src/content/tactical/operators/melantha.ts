import type { Definition as ElementalDefinition } from "../../../core/tactical/unit/capability/elemental/capability.js";
import type { Definition as OccupancyDefinition } from "../../../core/tactical/unit/capability/occupancy/capability.js";
import type { Definition as TargetableDefinition } from "../../../core/tactical/unit/capability/targetable/capability.js";
import { createArknightsElementalDefinition } from "../../../data/arknights/elemental.js";
import { Definitions } from "../../../core/tactical/unit/action/definitions.js";
import { create as createAttack } from "../actions/attack.js";
import { ref as unitRef } from "../../../core/tactical/unit/query.js";
import type { Profile } from "../../../data/arknights/operator.js";
import { getUnit, updateUnit } from "../../../core/tactical/battle/state.js";
import type { Definition as OperatorDefinition } from "../../../core/tactical/unit/archetype/operator.js";
import type { Definition as SkillDefinition } from "../../../core/tactical/unit/capability/skill/capability.js";
import { ref as activationRef } from "../../../core/tactical/unit/capability/skill/activation.js";
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
import * as attribute from "../../../core/tactical/unit/contribution/attribute.js";
import type { Direction } from "../../../core/tactical/geometry/direction.js";
import { createBlockGeometry } from "../../../core/tactical/geometry/shape.js";
import { secondsToTicks } from "../../../data/arknights/tick.js";

export interface Definition extends OperatorDefinition {
    readonly elemental: ElementalDefinition;
    readonly deployable: DeployableDefinition;
    readonly occupancy: OccupancyDefinition;
    readonly targetable: TargetableDefinition;
    readonly offense: Offense["definition"]["offense"];
    readonly skill: SkillDefinition;
    readonly profile: Profile;
    readonly direction: Direction;
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
                    value: [attribute.create({ multiplier: amount })],
                }),
            }),
        onDisable: (state, { unit, self }) =>
            updateUnit(state, {
                ...unit,
                offense: removeAttackContribution(unit.offense, `effect/${self.id}/attack`),
            }),
    };
}

export function create(profile: Profile, direction: Direction = "RIGHT"): Definition {
    if (profile.id !== "char_208_melan" || profile.skill.definition.id !== "skcom_atk_up[1]") {
        throw new TypeError("Melantha content requires her first skill");
    }

    const skillBonus = profile.skill.blackboard.find((entry) => entry.key === "atk")!.value;
    const talentBonus = profile.talents
        .find((talent) => talent.key === "1")
        ?.blackboard.find((entry) => entry.key === "atk")?.value;
    const talent = attackBonus("melantha/attack-talent", talentBonus ?? 0);
    const skillEffect = attackBonus("melantha/attack-up", skillBonus);
    const skill: SkillDefinition = {
        ...profile.skill.definition,
        activation: {
            ...profile.skill.definition.activation!,
            onStart(state, self) {
                const unit = getUnit(state, self.host.id);

                if (unit === undefined || !hasOffense(unit)) {
                    return state;
                }

                const result = install(state, unitRef(unit), skillEffect, {
                    source: unit.id,
                    scopes: [{ type: "SKILL", ref: activationRef(self) }],
                });

                return result.state;
            },
        },
    };

    return {
        id: profile.id,
        profile,
        direction,
        occupancy: {},
        targetable: {},
        deployable: createDeployableDefinition({
            cost: profile.attributes.cost,
            redeployTicks: secondsToTicks(profile.attributes.respawnTime),
            slots: 1,
            buildableType: "MELEE",
            advancedBuildableMask: 1,
        }),
        elemental: createArknightsElementalDefinition({ receiver: "CHARACTER" }),
        vitality: {
            maxHp: profile.attributes.maxHp,
            defense: profile.attributes.defense,
            resistance: profile.attributes.resistance,
        },
        offense: { attack: profile.attributes.attack },

        allegiance: { side: "ALLY" },
        spatial: { layer: "GROUND" },
        hit: { geometry: { shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.25 }] } },
        blocker: {
            capacity: profile.attributes.blockCapacity,
            geometry: createBlockGeometry({ radius: 0.70709997 }),
        },
        action: {
            definitions: Definitions.empty().add(
                createAttack({
                    id: "normal-attack",
                    speed: profile.attributes.attackSpeed,
                    triggerBindingId: "primary",
                    intervalTicks: secondsToTicks(profile.attributes.baseAttackTime),
                    recoveryTicks: 0,
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
                                        offsets: profile.range,
                                        direction,
                                    },
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
                }),
            ),
        },
        skill,
        onEnter(state, unitId) {
            const unit = getUnit(state, unitId);

            return talentBonus !== undefined && unit !== undefined && hasOffense(unit)
                ? install(state, unitRef(unit), talent).state
                : state;
        },
    };
}

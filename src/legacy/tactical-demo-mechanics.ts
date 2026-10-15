import { Definitions } from "../core/tactical/unit/action/definitions.js";
import {
    create as createAttack,
    isAttack,
    type Attack,
} from "../content/tactical/actions/attack.js";
import type { Input } from "../core/tactical/battle/contract.js";
import { CombatResources } from "../core/tactical/battle/resources.js";
import type { BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import * as enemy from "../core/tactical/unit/archetype/enemy.js";
import * as operator from "../core/tactical/unit/archetype/operator.js";
import type { ElementType } from "../core/tactical/unit/capability/elemental/capability.js";
import {
    createRouteDefinition,
    type RouteDefinition,
} from "../core/tactical/unit/capability/locomotion/route/definition.js";
import { createArknightsElementalDefinition } from "../data/arknights/elemental.js";
import { registerArknightsElementalBursts } from "../data/arknights/elemental-burst.js";
import { compileArknightsAttackBuffSkill } from "../data/arknights/skill-buff.js";
import { createTacticalCombatDemoSpec } from "./tactical-demo-combat.js";
import type { LegacyData } from "./tactical-demo-presentation.js";

const ELEMENT_SCENARIOS = {
    ELEMENT_NEURAL: "NEURAL",
    ELEMENT_EROSION: "EROSION",
    ELEMENT_BURN: "BURN",
    ELEMENT_NECROSIS: "NECROSIS",
} as const;

export type TacticalMechanicsScenario = "SKILL" | keyof typeof ELEMENT_SCENARIOS;

export function isTacticalMechanicsScenario(
    value: string | undefined,
): value is TacticalMechanicsScenario {
    return value === "SKILL" || (value !== undefined && Object.hasOwn(ELEMENT_SCENARIOS, value));
}

export function createTacticalMechanicsDemo(
    map: BattlefieldMap,
    route: RouteDefinition,
    data: LegacyData,
    seed: number,
    scenario: TacticalMechanicsScenario,
    rawSkill?: unknown,
): {
    readonly input: Input;
    readonly combat: CombatResources;
    readonly elementType: ElementType | null;
} {
    const combat = new CombatResources();
    const base = createTacticalCombatDemoSpec(map, route, data, seed, "PROJECTILE", combat);
    const source = base.initialUnits[0]!;
    const spawn = base.schedule.spawns[0]!;
    const maxTicks = (scenario === "SKILL" ? 120 : 60) * TICKS_PER_SECOND;
    const elementType = scenario === "SKILL" ? null : ELEMENT_SCENARIOS[scenario];
    const sourceDefinition = source.definition;
    const action = sourceDefinition.action.definitions.read<Attack | null>(
        "normal-attack",
        (current) => (isAttack(current) ? current : null),
    );

    if (action === undefined || action === null) {
        throw new TypeError("mechanics demo requires an ordinary attack");
    }

    const group = action.attack.targetGroups[0];
    const definition =
        scenario === "SKILL"
            ? operator.createDefinition({
                  ...sourceDefinition,
                  skill: combat.skills.register(compileArknightsAttackBuffSkill(rawSkill, 4))
                      .definition,
              })
            : operator.createDefinition({
                  ...sourceDefinition,
                  action: {
                      ...sourceDefinition.action,
                      definitions: Definitions.empty().add(
                          createAttack(
                              {
                                  ...action.attack,
                                  targetGroups: [
                                      {
                                          ...group,
                                          operations: [
                                              ...group.operations,
                                              {
                                                  type: "ELEMENT_DAMAGE",
                                                  elementType: ELEMENT_SCENARIOS[scenario],
                                                  power: 400,
                                              },
                                          ],
                                      },
                                  ],
                              },
                              combat,
                          ),
                      ),
                  },
              });

    if (elementType !== null) {
        registerArknightsElementalBursts(combat);
    }

    const target = enemy.createCombatDefinition({
        ...spawn.definition,
        vitality: { maxHp: 200_000 },
        locomotion: {
            ...spawn.definition.locomotion,
            moveSpeedPerTick: 0,
            minimumMoveSpeedPerTick: 0,
        },
        ...(elementType === null
            ? {}
            : { elemental: createArknightsElementalDefinition({ receiver: "ENEMY" }) }),
    });
    const targetRoute = createRouteDefinition({
        ...route,
        startPosition: [5, 6],
        endPosition: [5, 7],
        spawnOffset: [0, 0],
        spawnRandomRange: [0, 0],
        checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: maxTicks + 1 }],
    });

    return {
        input: {
            ...base,
            initialUnits: [{ ...source, definition }],
            schedule: {
                type: "TIMELINE",
                spawns: [{ ...spawn, definition: target, route: targetRoute, tick: 0 }],
            },
            maxTicks,
        },
        combat,
        elementType,
    };
}

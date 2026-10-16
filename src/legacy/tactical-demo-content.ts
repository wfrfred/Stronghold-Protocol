import type { Input } from "../core/tactical/battle/contract.js";
import type { BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import {
    createRouteDefinition,
    type RouteDefinition,
} from "../core/tactical/unit/capability/locomotion/route/definition.js";
import { prepare as prepareOperator, type Configuration } from "../data/arknights/operator.js";
import { prepare as prepareEnemy } from "../data/arknights/enemy.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import * as melantha from "../content/tactical/operators/melantha.js";
import * as mudrock from "../content/tactical/operators/mudrock.js";
import { create as createHound } from "../content/tactical/enemies/hound.js";
import {
    create as createCrossbowman,
    createArrow,
} from "../content/tactical/enemies/crossbowman.js";
import type { LegacyUnitMetadata } from "./tactical-demo-presentation.js";
import type { Unit } from "../core/tactical/unit/unit.js";

export interface Tables {
    readonly characters: Readonly<Record<string, unknown>>;
    readonly skills: Readonly<Record<string, unknown>>;
    readonly ranges: unknown;
    readonly favor: unknown;
    readonly equipment: Readonly<Record<string, unknown>>;
    readonly battleEquipment: Readonly<Record<string, unknown>>;
    readonly enemies: readonly unknown[];
}

export interface ConfigurationInput {
    readonly mudrock: Configuration;
    readonly melantha: Configuration;
    readonly enemyLevel: number;
    readonly seed: number;
}

export const defaults: ConfigurationInput = {
    mudrock: { elite: 2, level: 60, potential: 1, skillIndex: 1, skillLevel: 7, trust: 100 },
    melantha: { elite: 1, level: 55, potential: 1, skillIndex: 0, skillLevel: 7, trust: 100 },
    enemyLevel: 0,
    seed: 123,
};

export function createTacticalContentDemo(
    map: BattlefieldMap,
    route: RouteDefinition,
    tables: Tables,
    configuration: ConfigurationInput = defaults,
) {
    const prepare = (id: string, skillId: string, selected: Configuration) =>
        prepareOperator({ id, record: tables.characters[id] }, tables.skills[skillId], selected, {
            ranges: tables.ranges,
            favor: tables.favor,
            ...(selected.module === undefined
                ? {}
                : {
                      equipment: tables.equipment[selected.module.id],
                      battleEquipment: tables.battleEquipment[selected.module.id],
                  }),
        });
    const defender = mudrock.create(
        prepare("char_311_mudrok", "skchr_mudrok_2", configuration.mudrock),
    );
    const guard = melantha.create(
        prepare("char_208_melan", "skcom_atk_up[1]", configuration.melantha),
    );
    const profiles = tables.enemies.map((raw) =>
        prepareEnemy(raw, { level: configuration.enemyLevel }),
    );
    const hound = createHound(
        profiles.find((profile) => profile.id === "enemy_1000_gopro")!,
        {
            windupTicks: 4,
            recoveryTicks: 4,
            hitRadius: 0.2,
        },
    );
    const crossbowman = createCrossbowman(
        profiles.find((profile) => profile.id === "enemy_1003_ncbow")!,
        {
            windupTicks: 9,
            recoveryTicks: 6,
            hitRadius: 0.2,
            projectile: {
                definition: createArrow(),
                speedPerSecond: 6,
                contactRadius: 0.15,
                stopDelayTicks: 0,
            },
        },
    );
    const firstLane = createRouteDefinition({
        ...route,
        allowDiagonalMove: false,
        visitEveryTileCenter: true,
        checkpoints: [],
        spawnOffset: [0, 0],
        spawnRandomRange: [0, 0],
    });
    const secondLane = createRouteDefinition({ ...firstLane, startPosition: [2, 10] });
    const spawns: Extract<Input["schedule"], { type: "TIMELINE" }>["spawns"][number][] = [];

    for (let index = 0; index < 18; index++) {
        const tick = index * 3 * TICKS_PER_SECOND;

        for (const selectedRoute of [firstLane, secondLane]) {
            spawns.push({
                tick,
                definition: hound.definition,
                route: selectedRoute,
                alwaysCheckCurrentPoint: true,
                notCountInTotal: false,
                timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
            });
        }
    }
    for (let index = 0; index < 6; index++) {
        spawns.push({
            tick: index * 6 * TICKS_PER_SECOND,
            definition: crossbowman.definition,
            route: firstLane,
            alwaysCheckCurrentPoint: true,
            notCountInTotal: false,
            timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
        });
    }

    const input: Input = {
        map,
        schedule: { type: "TIMELINE", spawns },
        initialUnits: [
            { definition: defender.definition, position: [6, 5] },
            { definition: guard, position: [8, 3] },
        ],
        initialMechanisms: [],
        initialNavigationModifiers: [],
        predefines: [],
        maxTicks: 80 * TICKS_PER_SECOND,
        routeMoveMultiplier: 1,
        rngState: configuration.seed,
    };

    const metadata: Readonly<Record<string, LegacyUnitMetadata>> = {
        char_311_mudrok: {
            kind: "op",
            name: "泥岩",
            spine: "char_311_mudrok",
            avatar: "char_311_mudrok",
            skillIndex: configuration.mudrock.skillIndex,
            animation: { attack: "Attack", skillAttack: "Skill_1", skill: "ATTACK" },
        },
        char_208_melan: {
            kind: "op",
            name: "玫兰莎",
            spine: "char_208_melan",
            avatar: "char_208_melan",
            skillIndex: configuration.melantha.skillIndex,
            animation: { skill: "BUFF" },
        },
        enemy_1000_gopro: {
            kind: "enemy",
            name: hound.definition.profile.name,
            spine: "enemy_1000_gopro_2",
            avatar: "enemy_1000_gopro_2",
        },
        enemy_1003_ncbow: {
            kind: "enemy",
            name: crossbowman.definition.profile.name,
            spine: "enemy_1003_ncbow",
            avatar: "enemy_1003_ncbow",
            animation: {
                recoverySeconds:
                    crossbowman.definition.attackTiming.recoveryTicks / TICKS_PER_SECOND,
                lunge: false,
            },
        },
    };

    return { input, unitMetadata: (unit: Unit) => metadata[unit.definition.id] };
}

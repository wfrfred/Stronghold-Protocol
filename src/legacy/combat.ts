import { assertFiniteNumber, assertPositiveSafeInteger } from "../core/common/assert.js";
import { BattleRuntime } from "../core/tactical/battle/runtime.js";
import type { BattleSpec } from "../core/tactical/battle/spec.js";
import { createBattlefieldMap, type BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import { createTile } from "../core/tactical/battlefield/map/tile.js";
import type { DamageType } from "../core/tactical/unit/capability/vitality/damage/contract.js";
import { isTilePosition, Tile, type TilePosition } from "../core/tactical/geometry/coordinate.js";
import type { Direction } from "../core/tactical/geometry/direction.js";
import { RangeGrid } from "../core/tactical/geometry/range.js";
import type { RouteDefinition } from "../core/tactical/unit/capability/locomotion/route/definition.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import { createCombatEnemyDefinition } from "../core/tactical/unit/archetype/enemy.js";
import { createOperatorDefinition } from "../core/tactical/unit/archetype/operator.js";

interface LegacyCombatContent {
    readonly operators: readonly {
        readonly definition: unknown;
        readonly position: TilePosition;
        readonly direction?: Direction;
    }[];
    readonly enemies: readonly {
        readonly definition: unknown;
        readonly route: RouteDefinition;
        readonly tick?: number;
    }[];
    readonly maxTicks?: number;
    readonly seed?: number;
}

export type LegacyCombatOptions = LegacyCombatContent &
    ({ readonly map: BattlefieldMap } | { readonly rows: number; readonly columns: number });

const LEGACY_OPERATOR_HIT_RADIUS = 0.25;
const LEGACY_ENEMY_HIT_RADIUS = 0.1;

function record(value: unknown, name: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }

    return value as Record<string, unknown>;
}

function numberField(value: unknown, name: string): number {
    assertFiniteNumber(value, name, TypeError);

    return value;
}

function stringField(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`${name} must be a nonempty string`);
    }

    return value;
}

function damageType(value: unknown): DamageType {
    switch (value) {
        case undefined:
        case null:
        case "phys":
            return "PHYSICAL";

        case "arts":
            return "ARTS";

        case "true":
            return "TRUE";

        default:
            throw new RangeError("legacy combat only supports physical, arts and true damage");
    }
}

function attackTiming(stats: Record<string, unknown>) {
    const bat = numberField(stats.bat, "base attack time");
    const attackSpeed = numberField(stats.aspd, "attack speed");

    if (bat <= 0 || attackSpeed <= 0) {
        throw new RangeError("legacy attack time and attack speed must be positive");
    }

    return { baseAttackTimeTicks: bat * TICKS_PER_SECOND, attackSpeed };
}

function attackRange(value: unknown): RangeGrid {
    if (!Array.isArray(value)) {
        throw new TypeError("legacy operator attack range must be an array");
    }

    const offsets = value.map((offset: unknown) => {
        if (!isTilePosition(offset)) {
            throw new TypeError("legacy attack offsets must contain two integer coordinates");
        }

        return offset;
    });

    return RangeGrid.create(offsets);
}

function rejectContent(definition: Record<string, unknown>): void {
    if (definition.skill !== undefined && definition.skill !== null) {
        throw new RangeError("legacy combat does not execute operator skills");
    }

    for (const field of ["skills", "talents", "abilities", "tokens"]) {
        const content = definition[field];

        if (Array.isArray(content) && content.length > 0) {
            throw new RangeError(`legacy combat does not execute ${field}`);
        }
    }

    if (definition.attackKind === "heal") {
        throw new RangeError("legacy combat does not execute healing attacks");
    }
    if (definition.attackKind === "none") {
        throw new RangeError("legacy combat only supports ordinary attacks");
    }
    if (definition.targetPriority != null && definition.targetPriority !== "nearest") {
        throw new RangeError("legacy combat only supports nearest targeting");
    }
    if (definition.projectile != null && definition.projectile !== "none") {
        throw new RangeError("legacy combat does not execute projectiles");
    }
}

function operatorDefinition(value: unknown, direction: Direction) {
    const definition = record(value, "operator definition");
    const stats = record(definition.stats, "operator stats");
    rejectContent(definition);
    const timing = attackTiming(stats);

    const canTargetAir = definition.canHitFly ?? false;

    if (typeof canTargetAir !== "boolean") {
        throw new TypeError("canHitFly must be boolean when specified");
    }

    return createOperatorDefinition({
        id: stringField(definition.chessId, "chessId"),
        vitality: { maxHp: numberField(stats.maxHp, "maxHp") },
        offense: { attack: numberField(stats.atk, "attack") },
        allegiance: { side: "ALLY" },
        spatial: { layer: "GROUND" },
        hit: {
            geometry: {
                shapes: [{ type: "CIRCLE", offset: [0, 0], radius: LEGACY_OPERATOR_HIT_RADIUS }],
            },
        },
        status: { initialFlags: [] },
        defense: {
            defense: numberField(stats.def, "defense"),
            resistance: numberField(stats.res, "resistance"),
        },
        blocker: {
            capacity: numberField(stats.blockCnt, "block capacity"),
            geometry: { radius: 0.70709997 },
        },
        action: {
            attackSpeed: timing.attackSpeed,
            normalAction: {
                triggerBindingId: "primary",
                baseAttackTimeTicks: timing.baseAttackTimeTicks,
                recoveryTicks: 0,
                targetGroups: [
                    {
                        id: "primary",
                        targeting: {
                            type: "DAMAGE",
                            scope: {
                                type: "RANGE",
                                geometry: {
                                    type: "GRID",
                                    offsets: attackRange(definition.rangeGrid),
                                    direction,
                                },
                            },
                            canTargetAir,
                            includeBlockingRelations: true,
                            preferBlockingRelations: true,
                            ignoreTargetFree: false,
                            ignoreInvisible: false,
                            maxTargets: 1,
                        },
                        operations: [
                            {
                                type: "DAMAGE",
                                power: numberField(stats.atk, "attack"),
                                powerSource: "SOURCE_ATTACK",
                                damageType: damageType(definition.dmgType),
                            },
                        ],
                    },
                ],
                followUps: [],
            },
        },
    });
}

function enemyDefinition(value: unknown) {
    const definition = record(value, "enemy definition");
    const stats = record(definition.stats, "enemy stats");
    rejectContent(definition);
    const timing = attackTiming(stats);

    const motion = stats.motion;
    const applyWay = definition.applyWay;

    if (motion !== "WALK" && motion !== "FLY") {
        throw new RangeError("legacy enemy motion must be WALK or FLY");
    }
    if (applyWay !== "MELEE" && applyWay !== "RANGED") {
        throw new RangeError("legacy enemy applyWay must be MELEE or RANGED");
    }

    const radius = numberField(stats.rangeRadius, "enemy range radius");

    return createCombatEnemyDefinition({
        id: stringField(definition.key, "enemy key"),
        vitality: { maxHp: numberField(stats.maxHp, "maxHp") },
        offense: { attack: numberField(stats.atk, "attack") },
        locomotion: {
            moveSpeedPerTick: (numberField(stats.moveSpeed, "move speed") * 0.5) / TICKS_PER_SECOND,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
        },
        allegiance: { side: "ENEMY" },
        spatial: { layer: motion === "FLY" ? "AIR" : "GROUND" },
        hit: {
            geometry: {
                shapes: [{ type: "CIRCLE", offset: [0, 0], radius: LEGACY_ENEMY_HIT_RADIUS }],
            },
        },
        status: { initialFlags: [] },
        defense: {
            defense: numberField(stats.def, "defense"),
            resistance: numberField(stats.res, "resistance"),
        },
        blockable: { weight: numberField(stats.blockCnt, "block weight") },
        action: {
            attackSpeed: timing.attackSpeed,
            normalAction: {
                triggerBindingId: "primary",
                baseAttackTimeTicks: timing.baseAttackTimeTicks,
                recoveryTicks: applyWay === "RANGED" ? Math.ceil(0.35 * TICKS_PER_SECOND) : 0,
                targetGroups: [
                    {
                        id: "primary",
                        targeting: {
                            type: "DAMAGE",
                            scope:
                                applyWay === "MELEE"
                                    ? { type: "BLOCKER" }
                                    : {
                                          type: "RANGE",
                                          geometry: {
                                              type: "SHAPES",
                                              geometry: {
                                                  shapes: [
                                                      { type: "CIRCLE", offset: [0, 0], radius },
                                                  ],
                                              },
                                          },
                                      },
                            canTargetAir: true,
                            includeBlockingRelations: true,
                            preferBlockingRelations: true,
                            ignoreTargetFree: false,
                            ignoreInvisible: false,
                            maxTargets: 1,
                        },
                        operations: [
                            {
                                type: "DAMAGE",
                                power: numberField(stats.atk, "attack"),
                                powerSource: "SOURCE_ATTACK",
                                damageType: damageType(stats.dmgType),
                            },
                        ],
                    },
                ],
                followUps: [],
            },
        },
    });
}

function combatMap(options: LegacyCombatOptions): BattlefieldMap {
    if ("map" in options) {
        return options.map;
    }

    assertPositiveSafeInteger(options.rows, "legacy combat row count");
    assertPositiveSafeInteger(options.columns, "legacy combat column count");

    const tile = createTile({
        heightType: "LOWLAND",
        buildableType: "ALL",
        passableMask: "ALL",
        playerSideMask: "ALL",
        terrain: "NORMAL",
        mechanism: null,
    });

    return createBattlefieldMap(
        options.rows,
        options.columns,
        Array.from({ length: options.rows * options.columns }, () => tile),
    );
}

export function createLegacyCombatSpec(options: LegacyCombatOptions): BattleSpec {
    const initialUnits = options.operators.map((operator) => ({
        definition: operatorDefinition(operator.definition, operator.direction ?? "RIGHT"),
        position: Tile.center(operator.position),
    }));
    const spawns = options.enemies.map((enemy) => ({
        definition: enemyDefinition(enemy.definition),
        route: enemy.route,
        tick: enemy.tick ?? 0,
        timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
        alwaysCheckCurrentPoint: true,
        notCountInTotal: false,
    }));

    return {
        map: combatMap(options),
        initialUnits,
        schedule: { type: "TIMELINE", spawns },
        predefines: [],
        initialMechanisms: [],
        initialEffects: [],
        maxTicks: options.maxTicks ?? 600,
        moveMultiplier: 1,
        rngState: options.seed ?? 1,
        nextUnitId: 0,
        nextNavigationRequestId: 0,
    };
}

export function createLegacyCombatBattle(options: LegacyCombatOptions): BattleRuntime {
    return new BattleRuntime(createLegacyCombatSpec(options));
}

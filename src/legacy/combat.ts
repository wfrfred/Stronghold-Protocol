import { createArknightsElementalDefinition } from "../data/arknights/elemental.js";
import { Definitions } from "../core/tactical/unit/action/definitions.js";
import { create as createAttack } from "../content/tactical/actions/attack.js";
import * as filters from "../core/tactical/battle/targeting/filter.js";
import * as compare from "../core/tactical/battle/targeting/compare.js";
import { first } from "../core/tactical/battle/targeting/selector.js";
import { assertFiniteNumber, assertPositiveSafeInteger } from "../core/common/assert.js";
import { BattleRuntime } from "../core/tactical/battle/runtime.js";
import type { Input } from "../core/tactical/battle/contract.js";
import { createBattlefieldMap, type BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import { createTile } from "../core/tactical/battlefield/map/tile.js";
import type { DamageType } from "../core/tactical/battle/damage/contract.js";
import {
    createTilePosition,
    isTilePosition,
    Tile,
    type TilePosition,
} from "../core/tactical/geometry/coordinate.js";
import type { Direction } from "../core/tactical/geometry/direction.js";
import { fromTiles } from "../core/tactical/geometry/range.js";
import type { Input as RouteInput } from "../core/tactical/battle/creation/route.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import type { Definitions as CapabilityDefinitions } from "../core/tactical/unit/capability/catalog.js";
import type { Definition as UnitDefinition } from "../core/tactical/unit/unit.js";

interface LegacyCombatContent {
    readonly operators: readonly {
        readonly definition: unknown;
        readonly position: TilePosition;
        readonly direction?: Direction;
    }[];
    readonly enemies: readonly {
        readonly definition: unknown;
        readonly route: RouteInput;
        readonly tick?: number;
    }[];
    readonly maxTicks?: number;
    readonly seed?: number;
}

export type LegacyCombatOptions = LegacyCombatContent &
    ({ readonly map: BattlefieldMap } | { readonly rows: number; readonly columns: number });

const LEGACY_OPERATOR_HIT_RADIUS = 0.25;
const LEGACY_ENEMY_HIT_RADIUS = 0.1;
const LEGACY_ENEMY_HALF_BODY_WIDTH = 0.1;

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

function attackRange(value: unknown): readonly TilePosition[] {
    if (!Array.isArray(value)) {
        throw new TypeError("legacy operator attack range must be an array");
    }

    const seen = new Set<string>();

    return Array.from(value, (offset: unknown) => {
        if (!isTilePosition(offset)) {
            throw new TypeError("legacy attack offsets must contain two integer coordinates");
        }

        const tile = createTilePosition(offset[0], offset[1]);
        const key = `${tile[0]},${tile[1]}`;

        if (seen.has(key)) {
            throw new RangeError("legacy attack range must not contain duplicate tiles");
        }

        seen.add(key);

        return tile;
    });
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

    return {
        targetable: { restrictions: [] },
        elemental: createArknightsElementalDefinition({ receiver: "CHARACTER" }),
        id: stringField(definition.chessId, "chessId"),
        vitality: {
            maxHp: numberField(stats.maxHp, "maxHp"),
            defense: numberField(stats.def, "defense"),
            resistance: numberField(stats.res, "resistance"),
        },
        offense: { attack: numberField(stats.atk, "attack") },
        allegiance: { side: "ALLY" },
        layer: { type: "GROUND" },
        hitbox: {
            shape: { type: "CIRCLE", offset: [0, 0], radius: LEGACY_OPERATOR_HIT_RADIUS },
        },

        blocker: {
            capacity: numberField(stats.blockCnt, "block capacity"),
            geometry: { radius: 0.70709997 },
        },
        action: {
            definitions: Definitions.empty().add(
                createAttack({
                    id: "normal-attack",
                    speed: timing.attackSpeed,
                    triggerBindingId: "primary",
                    intervalTicks: timing.baseAttackTimeTicks,
                    recoveryTicks: 0,
                    targetGroups: [
                        {
                            id: "primary",
                            targeting: {
                                purposes: ["DAMAGE"],
                                filter: filters.and(
                                    filters.damage,
                                    ...(canTargetAir ? [] : [filters.ground]),
                                    filters.or(
                                        filters.range(
                                            fromTiles(attackRange(definition.rangeGrid), direction),
                                        ),
                                        filters.blocking,
                                    ),
                                ),
                                selector: first(
                                    1,
                                    compare.combine(compare.blockedFirst, compare.distance),
                                ),
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
                }),
            ),
        },
        direction,
    } satisfies UnitDefinition &
        Pick<
            CapabilityDefinitions,
            | "targetable"
            | "elemental"
            | "vitality"
            | "offense"
            | "allegiance"
            | "layer"
            | "hitbox"
            | "blocker"
            | "action"
        > & { readonly direction: Direction };
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
    const combat = filters.and(filters.present, filters.alive, filters.hostile, filters.blocker);

    return {
        spatialPresence: {},
        targetable: { restrictions: [] },
        elemental: createArknightsElementalDefinition({ receiver: "ENEMY" }),
        id: stringField(definition.key, "enemy key"),
        vitality: {
            maxHp: numberField(stats.maxHp, "maxHp"),
            defense: numberField(stats.def, "defense"),
            resistance: numberField(stats.res, "resistance"),
        },
        offense: { attack: numberField(stats.atk, "attack") },
        locomotion: {
            speed: (numberField(stats.moveSpeed, "move speed") * 0.5) / TICKS_PER_SECOND,
            minSpeed: (0.1 * 0.5) / TICKS_PER_SECOND,
            steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
            halfBodyWidth: LEGACY_ENEMY_HALF_BODY_WIDTH,
        },
        allegiance: { side: "ENEMY" },
        layer: { type: motion === "FLY" ? "AIR" : "GROUND" },
        hitbox: {
            shape: { type: "CIRCLE", offset: [0, 0], radius: LEGACY_ENEMY_HIT_RADIUS },
        },

        blockable: { volume: numberField(stats.blockCnt, "block volume") },
        action: {
            definitions: Definitions.empty().add(
                createAttack({
                    id: "normal-attack",
                    speed: timing.attackSpeed,
                    triggerBindingId: "primary",
                    intervalTicks: timing.baseAttackTimeTicks,
                    recoveryTicks: applyWay === "RANGED" ? Math.ceil(0.35 * TICKS_PER_SECOND) : 0,
                    targetGroups: [
                        {
                            id: "primary",
                            targeting: {
                                purposes: ["DAMAGE"],
                                filter:
                                    applyWay === "MELEE"
                                        ? combat
                                        : filters.or(
                                              combat,
                                              filters.and(
                                                  filters.damage,
                                                  filters.range([
                                                      {
                                                          type: "CIRCLE",
                                                          offset: [0, 0],
                                                          radius,
                                                      },
                                                  ]),
                                              ),
                                          ),
                                selector: first(
                                    1,
                                    compare.combine(compare.blockedFirst, compare.distance),
                                ),
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
                }),
            ),
        },
    } satisfies UnitDefinition &
        Pick<
            CapabilityDefinitions,
            | "spatialPresence"
            | "targetable"
            | "elemental"
            | "vitality"
            | "offense"
            | "locomotion"
            | "allegiance"
            | "layer"
            | "hitbox"
            | "blockable"
            | "action"
        >;
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

export function createLegacyCombatSpec(options: LegacyCombatOptions) {
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
        maxTicks: options.maxTicks ?? 600,
        routeMoveMultiplier: 1,
        rngState: options.seed ?? 1,
    } satisfies Input;
}

export function createLegacyCombatBattle(options: LegacyCombatOptions): BattleRuntime {
    return new BattleRuntime(createLegacyCombatSpec(options));
}

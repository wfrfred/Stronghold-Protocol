import type { BattleSpec } from "../core/tactical/battle/spec.js";
import type { BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import type { RouteDefinition } from "../core/tactical/unit/capability/locomotion/route/definition.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import { createLegacyCombatSpec } from "./combat.js";
import type { LegacyData } from "./tactical-demo-presentation.js";

function definition(value: unknown, id: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`missing demo combat definition: ${id}`);
    }

    return value as Record<string, unknown>;
}

export function createTacticalCombatDemoSpec(
    map: BattlefieldMap,
    route: RouteDefinition,
    data: LegacyData,
    seed: number,
): BattleSpec {
    const operator = definition(data.lookup("chess", "chess_char_3_05_a"), "chess_char_3_05_a");
    const enemy = definition(data.lookup("enemies", "enemy_1000_gopro_2"), "enemy_1000_gopro_2");
    const ordinaryOperator = {
        chessId: operator.chessId,
        stats: operator.stats,
        rangeGrid: operator.rangeGrid,
        dmgType: operator.dmgType,
        attackKind: operator.attackKind,
        projectile: operator.projectile,
        canHitFly: operator.canHitFly,
        targetPriority: "nearest",
    };
    const ordinaryEnemy = {
        key: enemy.key,
        stats: enemy.stats,
        applyWay: enemy.applyWay,
    };

    return createLegacyCombatSpec({
        map,
        operators: [{ definition: ordinaryOperator, position: [5, 6], direction: "RIGHT" }],
        enemies: [3, 11, 19].map((seconds) => ({
            definition: ordinaryEnemy,
            route,
            tick: seconds * TICKS_PER_SECOND,
        })),
        maxTicks: 45 * TICKS_PER_SECOND,
        seed,
    });
}

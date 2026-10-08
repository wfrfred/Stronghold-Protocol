import type { Input } from "../core/tactical/battle/contract.js";
import type { BattlefieldMap } from "../core/tactical/battlefield/map/map.js";
import type { RouteDefinition } from "../core/tactical/unit/capability/locomotion/route/definition.js";
import { TICKS_PER_SECOND } from "../core/tactical/tick.js";
import { createLegacyCombatSpec, type LegacyCombatOptions } from "./combat.js";
import type { LegacyData } from "./tactical-demo-presentation.js";

export type TacticalCombatScenario = "MIXED" | "RANGED" | "BLOCKING";

function definition(value: unknown, id: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`missing demo combat definition: ${id}`);
    }

    return value as Record<string, unknown>;
}

function ordinaryAttack(operator: Record<string, unknown>) {
    return {
        chessId: operator.chessId,
        stats: operator.stats,
        rangeGrid: operator.rangeGrid,
        dmgType: operator.dmgType,
        attackKind: operator.attackKind,
        // This demo settles hits immediately; projectile flight is not implemented yet.
        projectile: "none",
        canHitFly: operator.canHitFly,
        targetPriority: "nearest",
    };
}

export function createTacticalCombatDemoSpec(
    map: BattlefieldMap,
    route: RouteDefinition,
    data: LegacyData,
    seed: number,
    scenario: TacticalCombatScenario = "MIXED",
): Input {
    const operators: LegacyCombatOptions["operators"][number][] = [];

    if (scenario !== "RANGED") {
        operators.push({
            definition: ordinaryAttack(
                definition(data.lookup("chess", "chess_char_3_05_a"), "chess_char_3_05_a"),
            ),
            position: [5, 6],
            direction: "RIGHT",
        });
    }
    if (scenario !== "BLOCKING") {
        operators.push({
            definition: ordinaryAttack(
                definition(data.lookup("chess", "chess_char_3_01_a"), "chess_char_3_01_a"),
            ),
            position: [4, 4],
            direction: "RIGHT",
        });
    }

    const enemy = definition(data.lookup("enemies", "enemy_1000_gopro_2"), "enemy_1000_gopro_2");
    const ordinaryEnemy = {
        key: enemy.key,
        stats: enemy.stats,
        applyWay: enemy.applyWay,
    };

    return createLegacyCombatSpec({
        map,
        operators,
        enemies: (scenario === "BLOCKING" ? [3, 3, 3] : [3, 11, 19]).map((seconds) => ({
            definition: ordinaryEnemy,
            route,
            tick: seconds * TICKS_PER_SECOND,
        })),
        maxTicks: 45 * TICKS_PER_SECOND,
        seed,
    });
}

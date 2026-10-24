import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";
import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";

export function createLegacyCombatBattle(options) {
    return new BattleRuntime(createLegacyCombatSpec(options));
}

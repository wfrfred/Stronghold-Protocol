import {
    reconcileEffectSources,
    registerEffectSourceUnits,
    type EffectSourceServices,
} from "../../battlefield/effect-source/settlement.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattleState } from "../execution/context.js";

export function advanceEffectSources(
    state: BattleState,
    tick: number,
    resources: EffectSourceServices,
): void {
    reconcileEffectSources(state, resources, tick);
}

export function registerEffectSources(
    state: BattleState,
    unitIds: readonly UnitId[],
    tick: number,
    resources: EffectSourceServices,
): void {
    registerEffectSourceUnits(state, unitIds, resources, tick);
}

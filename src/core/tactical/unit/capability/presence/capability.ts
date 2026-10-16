import type { Unit } from "../../unit.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export type Definition = Readonly<Record<string, never>>;

export interface State {
    readonly present: boolean;
}

export interface SpatialPresence {
    readonly definition: { readonly spatialPresence: Definition };
    readonly spatialPresence: State;
}

export function hasSpatialPresence(unit: Unit): unit is Unit & SpatialPresence {
    return "spatialPresence" in unit && "spatialPresence" in unit.definition;
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return { state: battle, value: { present: true } };
};

export function isSpatiallyPresent(unit: Unit): boolean {
    return !hasSpatialPresence(unit) || unit.spatialPresence.present;
}

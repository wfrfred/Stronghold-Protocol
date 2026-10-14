import type { WorldPosition } from "../geometry/coordinate.js";
import type { Effects } from "./effect/effects.js";
import type { BattleState } from "../battle/state.js";
import type { BattlefieldRemovalReason } from "../battlefield/contract.js";

export type Id = number;

export type DefinitionId = string;

export type Lifecycle = "PRESENT" | "LEAVING";

export interface Definition {
    readonly id: DefinitionId;
    readonly onEnter?: (state: BattleState, unitId: Id) => BattleState;
    readonly onTick?: (state: BattleState, unitId: Id) => BattleState;
    readonly onLeave?: (state: BattleState, departure: Departure) => BattleState;
}

export interface Departure {
    readonly unit: Unit;
    readonly reason: BattlefieldRemovalReason;
}

export interface Unit {
    readonly id: Id;
    readonly lifecycle: Lifecycle;
    readonly definition: Definition;
    readonly position: WorldPosition;
    readonly effects: Effects;
}

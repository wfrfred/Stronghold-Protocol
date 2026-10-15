import type { WorldPosition } from "../geometry/coordinate.js";
import type { Effects } from "./effect/effects.js";
import type { State as BattleState } from "../battle/state.js";
import type { BattlefieldRemovalReason } from "../battlefield/contract.js";
import type { Identified } from "../../common/ref.js";

export type Id = number;

export type DefinitionId = string;

export type Lifecycle = "PRESENT" | "LEAVING";

export interface Definition {
    readonly id: DefinitionId;
    readonly onEnter?: (state: BattleState, unitId: Id) => BattleState;
    readonly onTick?: (battle: BattleState, self: Unit) => BattleState;
    readonly onLeave?: (state: BattleState, departure: Departure) => BattleState;
}

export interface Departure {
    readonly unit: Unit;
    readonly reason: BattlefieldRemovalReason;
}

export interface Unit extends Identified<{ readonly id: Id }> {
    readonly id: Id;
    readonly lifecycle: Lifecycle;
    readonly definition: Definition;
    readonly position: WorldPosition;
    readonly effects: Effects;
}

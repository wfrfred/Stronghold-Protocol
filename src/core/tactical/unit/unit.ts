import type { WorldPosition } from "../geometry/coordinate.js";
import type { CapabilityStates } from "./capability/catalog.js";
import type { Effects } from "./effect/effects.js";
import type { BattleState } from "../battle/state.js";

export type Id = number;

export type DefinitionId = string;

export type Lifecycle = "PRESENT" | "LEAVING";

export interface Definition {
    readonly id: DefinitionId;
    readonly onEnter?: (state: BattleState, unitId: Id) => BattleState;
}

export interface Unit extends Partial<CapabilityStates> {
    readonly id: Id;
    readonly lifecycle: Lifecycle;
    readonly definition: Definition;
    readonly position: WorldPosition;
    readonly effects: Effects;
}

import type {
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldView,
} from "../battlefield/contract.js";
import type { BattleCommand, BattleEvent } from "./contract.js";
import type { BattleExecutionState } from "./execution/state.js";

export interface BattlePhaseInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly commands: readonly BattleCommand[];
    readonly execution: BattleExecutionState;
    readonly removedUnits: BattlefieldChangeResult["removedUnits"];
}

export interface BattlePhaseResult<S = void> {
    readonly state: S;
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly BattleEvent[];
    readonly execution: BattleExecutionState;
}

export type BattlePhase<S = void> = (input: BattlePhaseInput, state: S) => BattlePhaseResult<S>;

export interface BattleSystem<S> {
    createState(): S;
}

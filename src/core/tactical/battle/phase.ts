import type {
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldView,
} from "../battlefield/contract.js";
import type { Command, Event } from "./contract.js";
import type { BattleExecutionState } from "./execution/state.js";

export interface BattlePhaseInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly commands: readonly Command[];
    readonly execution: BattleExecutionState;
    readonly removedUnits: BattlefieldChangeResult["removedUnits"];
}

export interface BattlePhaseOutput {
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
}

export interface BattlePhaseResult<S> extends BattlePhaseOutput {
    readonly state: S;
}

export type BattlePhase<S, I extends BattlePhaseInput = BattlePhaseInput> = (
    input: I,
    state: S,
) => BattlePhaseResult<S>;

export type StatelessBattlePhase<I extends BattlePhaseInput = BattlePhaseInput> = (
    input: I,
) => BattlePhaseOutput;

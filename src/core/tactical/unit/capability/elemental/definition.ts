import type { BattleState } from "../../../battle/state.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { CallContext } from "../../../battle/execution/call.js";
import type { ElementalBurst } from "./settlement.js";

export interface ElementalBurstContext {
    readonly burst: ElementalBurst;
    readonly tick: number;
    readonly previousTick: number;
    readonly facts: BattlefieldView;
    readonly call: CallContext;
}

export interface ElementalBurstDefinition {
    readonly begin: (state: BattleState, context: ElementalBurstContext) => BattleState;
    readonly advance?: (state: BattleState, context: ElementalBurstContext) => BattleState;
}

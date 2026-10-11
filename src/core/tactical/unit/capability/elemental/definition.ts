import type { BattleState } from "../../../battle/execution/context.js";
import type { BattlefieldView } from "../../../battlefield/contract.js";
import type { DamageReport, DamageRequest } from "../vitality/damage/contract.js";
import type { ElementalBurst } from "./settlement.js";

export interface ElementalBurstContext {
    readonly battle: BattleState;
    readonly burst: ElementalBurst;
    readonly tick: number;
    readonly previousTick: number;
    readonly facts: BattlefieldView;
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    drainSp(amount: number): number;
}

export interface ElementalBurstDefinition {
    readonly begin: (context: ElementalBurstContext) => undefined;
    readonly advance?: (context: ElementalBurstContext) => undefined;
}

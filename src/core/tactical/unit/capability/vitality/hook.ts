import type { Unit } from "../../unit.js";
import type { BattleState } from "../../../battle/execution/context.js";
import type { DamageReport, DamageRequest } from "./damage/contract.js";
import type { HealingReport, HealingRequest } from "./healing/contract.js";

export interface Result<V> {
    readonly value: V;
    readonly stopDispatch?: boolean;
}

export interface Operations {
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    heal(request: Omit<HealingRequest, "tick">): HealingReport;
}

export interface Context<R> {
    readonly battle: BattleState;
    readonly unit: Unit;
    readonly request: R;
    readonly tick: number;
    readonly operations: Operations;
}

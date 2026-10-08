import type { EffectLifecycleOperations, EffectView } from "../effects/contract.js";
import type { DamageReport, DamageRequest } from "../vitality/damage/contract.js";
import type { ElementalBurst } from "./settlement.js";

export interface ElementalBurstContext {
    readonly burst: ElementalBurst;
    readonly tick: number;
    readonly previousTick: number;
    readonly facts: EffectView;
    readonly effects: EffectLifecycleOperations;
    damage(request: Omit<DamageRequest, "tick">): DamageReport;
    drainSp(amount: number): number;
}

export interface CompiledElementalBurst {
    readonly begin: (context: ElementalBurstContext) => undefined;
    readonly advance?: (context: ElementalBurstContext) => undefined;
}

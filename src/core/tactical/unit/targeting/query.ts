import type { BattlefieldView } from "../../battlefield/contract.js";
import type { Vitality } from "../capability/vitality/capability.js";
import type { Unit, Id } from "../unit.js";

export interface TargetQueryContext {
    readonly battlefield: Pick<BattlefieldView, "getUnit">;
}

export interface CompiledTargeting<C extends TargetQueryContext = TargetQueryContext> {
    readonly candidates: (context: C) => Iterable<Id>;
    readonly accepts: (context: C, target: Unit) => boolean;
    readonly compare: (context: C, left: Unit, right: Unit) => number;
    readonly limit: (context: C) => number;
}

export type CombatTargetingView = Pick<
    BattlefieldView,
    "unitIds" | "getUnit" | "blockerOf" | "blockedBy"
>;

export interface CombatTargetQueryContext extends TargetQueryContext {
    readonly source: Unit;
    readonly battlefield: CombatTargetingView;
}

export type HealingMaxHpProvider = (
    unit: Unit & Vitality,
    context: CombatTargetQueryContext,
) => number;

export type QueryPurpose = "DAMAGE" | "HEAL" | "ELEMENT_DAMAGE" | "ELEMENT_HEAL";

import type { BattlefieldView } from "../battlefield/contract.js";
import type { Unit, UnitId } from "../unit/unit.js";

export interface TargetQueryContext {
    readonly battlefield: Pick<BattlefieldView, "getUnit">;
}

export interface CompiledTargeting<C extends TargetQueryContext = TargetQueryContext> {
    readonly candidates: (context: C) => Iterable<UnitId>;
    readonly accepts: (context: C, target: Unit) => boolean;
    readonly compare: (context: C, left: Unit, right: Unit) => number;
    readonly limit: (context: C) => number;
}

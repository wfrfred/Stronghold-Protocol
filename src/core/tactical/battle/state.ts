import type { Seed } from "../../common/rng.js";
import type { NavigationRequestId } from "../navigation/request.js";
import type { UnitId } from "../unit/unit.js";
import type { MechanismId } from "../battlefield/mechanism.js";
import type { SpatialEffectId } from "../battlefield/navigation-effect.js";

export interface BattleExecutionState {
    readonly rngState: Seed;
    readonly nextUnitId: UnitId;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly nextMechanismId: MechanismId;
    readonly nextSpatialEffectId: SpatialEffectId;
}

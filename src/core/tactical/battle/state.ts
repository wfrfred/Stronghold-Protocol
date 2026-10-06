import type { Seed } from "../../common/rng.js";
import type { NavigationRequestId } from "../navigation/request.js";
import type { UnitId } from "../unit/unit.js";

export interface BattleExecutionState {
    readonly rngState: Seed;
    readonly nextUnitId: UnitId;
    readonly nextNavigationRequestId: NavigationRequestId;
}

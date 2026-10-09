import type { ProjectileId } from "../../battlefield/projectile/state.js";
import type { Seed } from "../../../common/rng.js";
import type { NavigationRequestId } from "../../battlefield/navigation/request.js";
import type { UnitId } from "../../unit/unit.js";
import type { MechanismId } from "../../battlefield/mechanism.js";
import type { NavigationModifierId } from "../../battlefield/navigation/modifier.js";

export interface BattleExecutionState {
    readonly rngState: Seed;
    readonly nextProjectileId: ProjectileId;
    readonly nextUnitId: UnitId;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly nextMechanismId: MechanismId;
    readonly nextNavigationModifierId: NavigationModifierId;
}

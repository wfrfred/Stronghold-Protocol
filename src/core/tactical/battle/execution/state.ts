import type { ProjectileId } from "../../battlefield/projectile/projectile.js";
import type { Seed } from "../../../common/rng.js";
import type { Id } from "../../unit/unit.js";
import type { MechanismId } from "../../battlefield/mechanism.js";
import type { Id as OverlayId } from "../../battlefield/navigation/overlay.js";

export interface BattleExecutionState {
    readonly rngState: Seed;
    readonly nextCardId: number;
    readonly nextProjectileId: ProjectileId;
    readonly nextUnitId: Id;
    readonly nextMechanismId: MechanismId;
    readonly nextOverlayId: OverlayId;
}

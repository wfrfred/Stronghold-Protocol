import type { Id as UnitId } from "../../unit/unit.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { StopReason } from "./definition.js";
import type { Id } from "./projectile.js";

export type Signal = {
    readonly projectileId: Id;
    readonly tick: number;
    readonly position: WorldPosition;
} & (
    | { readonly type: "PROJECTILE_STOPPED"; readonly reason: StopReason }
    | { readonly type: "PROJECTILE_REACHED"; readonly source: UnitId | null }
    | {
          readonly type: "PROJECTILE_HIT";
          readonly source: UnitId | null;
          readonly targetUnitId: UnitId;
      }
);

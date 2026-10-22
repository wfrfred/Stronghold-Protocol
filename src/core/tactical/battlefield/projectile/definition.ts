import type { State as BattleState } from "../../battle/state.js";
import type { Projectile } from "./projectile.js";

export type StopReason = "ARRIVED" | "EXPIRED" | "EXPLICIT" | "SOURCE_UNAVAILABLE" | "DISPEL";

export interface Definition<S extends object> {
    readonly id: string;
    readonly onCreate?: (battle: BattleState, self: Projectile<S>) => BattleState;
    readonly onAdvance?: (battle: BattleState, self: Projectile<S>) => BattleState;
    readonly onTerminate?: (
        battle: BattleState,
        self: Projectile<S>,
        reason: StopReason,
    ) => BattleState;
}

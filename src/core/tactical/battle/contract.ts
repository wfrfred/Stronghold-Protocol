import type { BattlefieldRemovalReason } from "../battlefield/contract.js";
import type { BlockingRelation } from "../battlefield/blocking.js";
import type { DamageType } from "../unit/capability/action.js";
import type { MechanismRuntime } from "../battlefield/mechanism.js";
import type { NavigationSpatialEffect } from "../battlefield/navigation-effect.js";
import type { NavigationOutcome } from "../navigation/state.js";
import type { WorldPosition } from "../geometry/coordinate.js";
import type { RouteSignal } from "../route/execution.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type { PredefinedCommand, PredefinedPresence } from "./predefined.js";
import type { SpawnScheduleState } from "./schedule.js";
import type { AlternativeRouteCommand } from "./route-control.js";
import type { BattleExecutionState } from "./state.js";
import type { DeploymentCommand } from "./deployment.js";
import type { SupportRelation } from "../battlefield/support.js";

export type BattleCommand =
    | PredefinedCommand
    | AlternativeRouteCommand
    | DeploymentCommand
    | { readonly type: "TRIGGER_BRANCH"; readonly branchId: string; readonly isLoop: boolean };

export type BattleEvent =
    | {
          readonly type: "UNIT_DEPLOYED" | "UNIT_RELOCATED";
          readonly unitId: UnitId;
          readonly position: WorldPosition;
          readonly tick: number;
      }
    | ({ readonly type: "SUPPORT_LOST"; readonly tick: number } & SupportRelation)
    | { readonly type: "ENEMY_SPAWNED"; readonly unitId: UnitId; readonly tick: number }
    | {
          readonly type: "ATTACK";
          readonly sourceUnitId: UnitId;
          readonly targetUnitId: UnitId;
          readonly damageType: DamageType;
          readonly tick: number;
      }
    | {
          readonly type: "DAMAGE";
          readonly sourceUnitId: UnitId;
          readonly targetUnitId: UnitId;
          readonly damageType: DamageType;
          readonly amount: number;
          readonly hp: number;
          readonly tick: number;
      }
    | {
          readonly type: "ROUTE";
          readonly unitId: UnitId;
          readonly signal: RouteSignal;
          readonly position: WorldPosition;
          readonly tick: number;
      }
    | {
          readonly type: "NAVIGATION";
          readonly unitId: UnitId;
          readonly outcome: NavigationOutcome;
          readonly tick: number;
      }
    | { readonly type: "ROUTE_COMPLETED"; readonly unitId: UnitId; readonly tick: number }
    | {
          readonly type: "UNIT_REMOVED";
          readonly unitId: UnitId;
          readonly reason: BattlefieldRemovalReason;
          readonly tick: number;
      };

export interface BattleResult {
    readonly reason: "SCHEDULE_COMPLETED" | "TIME_LIMIT";
    readonly elapsedTicks: number;
    readonly spawnedCount: number;
    readonly completedRouteCount: number;
    readonly remainingUnitIds: readonly UnitId[];
    readonly unspawnedCount: number;
}

export interface BattleSnapshot {
    readonly tickIndex: number;
    readonly spawning: SpawnScheduleState;
    readonly execution: BattleExecutionState;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly units: readonly Unit[];
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: readonly MechanismRuntime[];
    readonly effects: readonly NavigationSpatialEffect[];
    readonly completedRouteCount: number;
    readonly result: BattleResult | null;
}

export interface BattleStep {
    readonly events: readonly BattleEvent[];
    readonly result: BattleResult | null;
}

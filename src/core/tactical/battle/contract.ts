import type { Seed } from "../../common/rng.js";
import type { BattlefieldMap } from "../battlefield/map/map.js";
import type { UnitPlacementDefinition } from "./creation/placement.js";
import type { MechanismPlacementDefinition } from "./creation/mechanism.js";
import type { NavigationModifierPlacementDefinition } from "./creation/navigation-modifier.js";
import type { SpawnScheduleDefinition } from "./schedule/definition.js";
import type { BattlefieldChangeResult } from "../battlefield/contract.js";
import type { BlockingRelation } from "../battlefield/blocking/relations.js";
import type { CombatEvent } from "./execution/event.js";
import type { MechanismRuntime } from "../battlefield/mechanism.js";
import type { NavigationModifier } from "../battlefield/navigation/modifier.js";
import type { NavigationOutcome } from "../battlefield/navigation/state.js";
import type { WorldPosition } from "../geometry/coordinate.js";
import type { RouteSignal } from "../unit/capability/locomotion/route/execution.js";
import type { Unit, UnitId } from "../unit/unit.js";
import type {
    PredefinedInstanceDefinition,
    PredefinedCommand,
    PredefinedPresence,
} from "./steps/predefined.js";
import type { SpawnScheduleState } from "./schedule/state.js";
import type { AlternativeRouteCommand } from "./steps/route-control.js";
import type { BattleExecutionState } from "./execution/state.js";
import type { DeploymentCommand } from "./steps/deployment.js";
import type { SupportRelation } from "../battlefield/support/relations.js";
import type {
    ActionExecutionId,
    ActionExecutionSignal,
    ActionExecutionState,
} from "../unit/capability/action/process.js";
import type { ProjectileId, ProjectileState } from "../battlefield/projectile/state.js";
import type { ProjectileSignal } from "../battlefield/projectile/settlement.js";
import type { ElementalSignal } from "../unit/capability/elemental/execution.js";
import type { SkillSignal } from "../unit/capability/skill/execution.js";

/** Shared creation data. Keep this input unchanged for the runtime lifetime. */
export interface Input {
    readonly map: BattlefieldMap;
    readonly schedule: SpawnScheduleDefinition;
    readonly predefines: readonly PredefinedInstanceDefinition[];
    readonly initialUnits: readonly UnitPlacementDefinition[];
    readonly initialMechanisms: readonly MechanismPlacementDefinition[];
    readonly initialNavigationModifiers: readonly NavigationModifierPlacementDefinition[];
    readonly maxTicks: number;
    readonly routeMoveMultiplier: number;
    readonly rngState: Seed;
}

export type Command =
    | PredefinedCommand
    | AlternativeRouteCommand
    | DeploymentCommand
    | { readonly type: "ACTIVATE_SKILL"; readonly unitId: UnitId }
    | { readonly type: "FINISH_SKILL"; readonly unitId: UnitId }
    | { readonly type: "CANCEL_ACTION_EXECUTION"; readonly executionId: ActionExecutionId }
    | { readonly type: "STOP_PROJECTILE"; readonly projectileId: ProjectileId }
    | { readonly type: "TRIGGER_BRANCH"; readonly branchId: string; readonly isLoop: boolean };

export type Event =
    | CombatEvent
    | ActionExecutionSignal
    | ProjectileSignal
    | SkillSignal
    | ElementalSignal
    | {
          readonly type: "UNIT_DEPLOYED" | "UNIT_RELOCATED";
          readonly unitId: UnitId;
          readonly position: WorldPosition;
          readonly tick: number;
      }
    | ({ readonly type: "SUPPORT_LOST"; readonly tick: number } & SupportRelation)
    | { readonly type: "ENEMY_SPAWNED"; readonly unitId: UnitId; readonly tick: number }
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
    | ({
          readonly type: "UNIT_REMOVED";
          readonly tick: number;
      } & BattlefieldChangeResult["removedUnits"][number]);

export interface Result {
    readonly reason: "SCHEDULE_COMPLETED" | "TIME_LIMIT";
    readonly elapsedTicks: number;
    readonly spawnedCount: number;
    readonly completedRouteCount: number;
    readonly remainingUnitIds: readonly UnitId[];
    readonly unspawnedCount: number;
}

export interface Snapshot {
    readonly tickIndex: number;
    readonly spawning: SpawnScheduleState;
    readonly execution: BattleExecutionState;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly actionExecution: ActionExecutionState;
    readonly projectiles: ProjectileState;
    readonly units: readonly Unit[];
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: readonly MechanismRuntime[];
    readonly navigationModifiers: readonly NavigationModifier[];
    readonly completedRouteCount: number;
    readonly result: Result | null;
}

export interface Step {
    readonly events: readonly Event[];
    readonly result: Result | null;
}

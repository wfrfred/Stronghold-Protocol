import type { Seed } from "../../common/rng.js";
import type { BattlefieldMap } from "../battlefield/map/map.js";
import type { UnitPlacementDefinition } from "./creation/placement.js";
import type { MechanismPlacementDefinition } from "./creation/mechanism.js";
import type { SpawnScheduleDefinition } from "./schedule/definition.js";
import type { BattlefieldChangeResult } from "../battlefield/contract.js";
import type { BlockingRelation } from "../battlefield/blocking/relations.js";
import type { CombatEvent } from "./execution/event.js";
import type { Mechanism } from "../battlefield/mechanism.js";
import type { State as NavigationState } from "../battlefield/navigation/state.js";
import type { WorldPosition } from "../geometry/coordinate.js";
import type { Signal as RouteSignal } from "../unit/capability/route/operations.js";
import type { Unit, Id } from "../unit/unit.js";
import type {
    Input as DeploymentInput,
    State as DeploymentState,
} from "./deployment/deployment.js";
import type {
    PredefinedDefinition,
    PredefinedCommand,
    PredefinedPresence,
} from "./steps/predefined.js";
import type { SpawnScheduleState } from "./schedule/state.js";
import type { AlternativeRouteCommand } from "./steps/movement.js";
import type { BattleExecutionState } from "./execution/state.js";
import type {
    DeploymentCommand,
    Rejection as DeploymentRejection,
} from "./deployment/operations.js";
import type { SupportRelation } from "../battlefield/support/relations.js";
import type { Ref } from "../../common/ref.js";
import type { Signal as ActionSignal } from "../unit/action/event.js";
import type { Actions } from "../unit/action/actions.js";
import type { ProjectileId, ProjectileState } from "../battlefield/projectile/projectile.js";
import type { ProjectileSignal } from "../battlefield/projectile/settlement.js";
import type { Signal as ElementalSignal } from "../unit/capability/elemental/operations.js";
import type { Signal as SkillSignal } from "../unit/capability/skill/operations.js";

/** Shared creation data. Keep this input unchanged for the runtime lifetime. */
export interface Input {
    readonly deployment?: DeploymentInput;
    readonly map: BattlefieldMap;
    readonly schedule: SpawnScheduleDefinition;
    readonly predefines: readonly PredefinedDefinition[];
    readonly initialUnits: readonly UnitPlacementDefinition[];
    readonly initialMechanisms: readonly MechanismPlacementDefinition[];
    readonly maxTicks: number;
    readonly routeMoveMultiplier: number;
    readonly rngState: Seed;
}

export type Command =
    | PredefinedCommand
    | AlternativeRouteCommand
    | DeploymentCommand
    | { readonly type: "ACTIVATE_SKILL"; readonly unitId: Id }
    | { readonly type: "FINISH_SKILL"; readonly unitId: Id }
    | {
          readonly type: "CANCEL_ACTION_EXECUTION";
          readonly ref: Ref<ReturnType<Actions["values"]>[number]>;
      }
    | { readonly type: "STOP_PROJECTILE"; readonly projectileId: ProjectileId }
    | { readonly type: "TRIGGER_BRANCH"; readonly branchId: string; readonly isLoop: boolean };

export type Event =
    | {
          readonly type: "DEPLOYMENT_REJECTED";
          readonly cardId: number;
          readonly reason: DeploymentRejection;
          readonly tick: number;
      }
    | CombatEvent
    | ActionSignal
    | ProjectileSignal
    | SkillSignal
    | ElementalSignal
    | {
          readonly type: "UNIT_DEPLOYED" | "UNIT_RELOCATED";
          readonly unitId: Id;
          readonly position: WorldPosition;
          readonly tick: number;
      }
    | ({ readonly type: "SUPPORT_LOST"; readonly tick: number } & SupportRelation)
    | { readonly type: "ENEMY_SPAWNED"; readonly unitId: Id; readonly tick: number }
    | {
          readonly type: "ROUTE";
          readonly unitId: Id;
          readonly signal: RouteSignal;
          readonly position: WorldPosition;
          readonly tick: number;
      }
    | { readonly type: "ROUTE_COMPLETED"; readonly unitId: Id; readonly tick: number }
    | ({
          readonly type: "UNIT_REMOVED";
          readonly tick: number;
      } & BattlefieldChangeResult["removedUnits"][number]);

export interface Result {
    readonly reason: "SCHEDULE_COMPLETED" | "TIME_LIMIT";
    readonly elapsedTicks: number;
    readonly spawnedCount: number;
    readonly completedRouteCount: number;
    readonly remainingUnitIds: readonly Id[];
    readonly unspawnedCount: number;
}

export interface Snapshot {
    readonly deployment: DeploymentState;
    readonly tickIndex: number;
    readonly spawning: SpawnScheduleState;
    readonly execution: BattleExecutionState;
    readonly predefinedPresence: readonly PredefinedPresence[];
    readonly projectiles: ProjectileState;
    readonly units: readonly Unit[];
    readonly blockingRelations: readonly BlockingRelation[];
    readonly supportRelations: readonly SupportRelation[];
    readonly mechanisms: readonly Mechanism[];
    readonly navigation: NavigationState;
    readonly completedRouteCount: number;
    readonly result: Result | null;
}

export interface Step {
    readonly events: readonly Event[];
    readonly result: Result | null;
}

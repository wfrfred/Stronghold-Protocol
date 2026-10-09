import { createRng } from "../../../common/rng.js";
import type { BattlefieldChange } from "../../battlefield/contract.js";
import { createWorldOffset } from "../../geometry/coordinate.js";
import type { RouteDefinition } from "../../unit/capability/locomotion/route/definition.js";
import { createRouteExecution } from "../../unit/capability/locomotion/route/execution.js";
import {
    initializeRouteControl,
    type LocatedRouteSignal,
} from "../../unit/capability/locomotion/route-control.js";
import { hasRoutedLocomotion } from "../../unit/capability/locomotion/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import type { BattleExecutionState } from "../execution/state.js";

export type AlternativeRouteCommand =
    | {
          readonly type: "SET_ALTERNATIVE_ROUTE";
          readonly unitId: UnitId;
          readonly route: RouteDefinition;
          readonly alwaysCheckCurrentPoint: boolean;
      }
    | { readonly type: "CLEAR_ALTERNATIVE_ROUTE"; readonly unitId: UnitId };

export interface UnitRouteSignal extends LocatedRouteSignal {
    readonly unitId: UnitId;
}

export interface AlternativeRouteChanges {
    readonly changes: readonly BattlefieldChange[];
    readonly execution: BattleExecutionState;
    readonly signals: readonly UnitRouteSignal[];
}

export function changeAlternativeRoutes(
    getUnit: (id: UnitId) => Unit | undefined,
    commands: readonly AlternativeRouteCommand[],
    execution: BattleExecutionState,
    tick: number,
): AlternativeRouteChanges {
    const units = new Map<UnitId, Unit>();
    const signals: UnitRouteSignal[] = [];

    for (const command of commands) {
        const unit = units.get(command.unitId) ?? getUnit(command.unitId);

        if (unit === undefined) {
            throw new RangeError(`unknown alternative route unit: ${command.unitId}`);
        }
        if (!hasRoutedLocomotion(unit)) {
            throw new RangeError(`unit has no routed locomotion: ${command.unitId}`);
        }

        if (command.type === "CLEAR_ALTERNATIVE_ROUTE") {
            const cleared = { ...unit, locomotion: { ...unit.locomotion, alternativeRoute: null } };
            units.set(unit.id, cleared);
            continue;
        }

        const context = createRouteExecution(
            createRng(execution.rngState),
            execution.nextNavigationRequestId,
            tick,
        );
        const initialized = initializeRouteControl(
            command.route,
            unit.locomotion.mainRoute.route.timing,
            command.alwaysCheckCurrentPoint,
            createWorldOffset(0, 0),
            unit.position,
            context,
            isSpatiallyPresent(unit),
        );

        const updated = {
            ...unit,
            position: initialized.position,
            spatialPresence: { present: initialized.present },
            locomotion: { ...unit.locomotion, alternativeRoute: initialized.control },
        };
        units.set(unit.id, updated);
        execution = { ...execution, ...context.state() };
        signals.push(...initialized.signals.map((signal) => ({ ...signal, unitId: unit.id })));
    }

    const changes: BattlefieldChange[] = [...units.values()].map((unit) => ({
        type: "UPDATE_UNIT",
        unit,
    }));
    const released = new Set(
        signals
            .filter(({ signal }) => signal.type === "APPEAR_AT_POS" || signal.type === "DISAPPEAR")
            .map(({ unitId }) => unitId),
    );

    for (const unitId of released) {
        changes.push({ type: "RELEASE_BLOCKING_RELATIONS", unitId });
    }

    return {
        changes,
        execution,
        signals,
    };
}

import type { BattlefieldChange } from "../../battlefield/contract.js";
import type * as computation from "../../modifier/computation.js";
import type { Context } from "../../unit/capability/contribution.js";
import { hasRoutedLocomotion } from "../../unit/capability/locomotion/capability.js";
import { hasAction } from "../../unit/capability/action/capability.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";
import { stepRoutedUnit } from "../../unit/capability/locomotion/step.js";
import type { UnitId } from "../../unit/unit.js";
import { changeAlternativeRoutes } from "./route-control.js";
import type { Command, Event } from "../contract.js";
import { removeUnitWithEffects, type UnitLifecycleResources } from "../execution/unit-lifecycle.js";
import {
    advanceBattlefield,
    appendEvents,
    battlefieldView,
    type BattleState,
} from "../execution/context.js";

export function advanceRouteCommands(
    state: BattleState,
    commands: readonly Command[],
    tick: number,
): void {
    const battlefield = battlefieldView(state);
    const changed = changeAlternativeRoutes(
        (id) => battlefield.getUnit(id),
        commands.filter(
            (command) =>
                command.type === "SET_ALTERNATIVE_ROUTE" ||
                command.type === "CLEAR_ALTERNATIVE_ROUTE",
        ),
        state.execution,
        tick,
    );
    state.execution = changed.execution;
    appendEvents(
        state,
        changed.signals.map((signal) => ({ type: "ROUTE", ...signal, tick })),
    );
    advanceBattlefield(state, changed.changes);
}

export function advanceMovement(
    state: BattleState,
    tick: number,
    {
        routeMoveMultiplier,
        movementAllowed,
    }: {
        readonly routeMoveMultiplier: number;
        readonly movementAllowed?: (unitId: UnitId) => boolean;
    },
    resources: UnitLifecycleResources & {
        readonly computations: computation.Computations<Context>;
    },
): void {
    const battlefield = state.battlefield.snapshot("draft");
    let execution = state.execution;
    const changes: BattlefieldChange[] = [];
    const events: Event[] = [];
    const completed: UnitId[] = [];

    for (const unitId of [...battlefield.unitIds].sort((left, right) => left - right)) {
        const unit = battlefield.getUnit(unitId)!;

        if (!hasRoutedLocomotion(unit)) {
            continue;
        }

        const moved = stepRoutedUnit(unit, {
            tick,
            maps: battlefield.navigationMaps,
            fieldCache: battlefield.fieldCache,
            moveMultiplier: routeMoveMultiplier,
            evaluateContributions: resources.computations.bind({ unit, battlefield }),
            movementAllowed:
                (movementAllowed?.(unitId) ?? true) &&
                !hasStatusFlag(unit, "STUNNED") &&
                battlefield.blockerOf(unitId) === undefined &&
                (!hasAction(unit) || tick >= unit.action.recoveryUntilTick),
            waitTickAllowed: true,
            routeAdvanceAllowed: true,
            rngState: execution.rngState,
            nextNavigationRequestId: execution.nextNavigationRequestId,
        });
        execution = {
            ...execution,
            rngState: moved.rngState,
            nextNavigationRequestId: moved.nextNavigationRequestId,
        };

        for (const signal of moved.signals) {
            events.push({ type: "ROUTE", unitId, ...signal, tick });
        }

        const releasesBlocking = moved.signals.some(
            ({ signal }) => signal.type === "APPEAR_AT_POS" || signal.type === "DISAPPEAR",
        );

        if (releasesBlocking) {
            changes.push({ type: "RELEASE_BLOCKING_RELATIONS", unitId });
        }
        for (const outcome of moved.outcomes) {
            events.push({ type: "NAVIGATION", unitId, outcome, tick });
        }

        if (
            moved.unit.locomotion.mainRoute.route.progress.phase === "COMPLETED" &&
            (battlefield.blockerOf(unitId) === undefined || releasesBlocking)
        ) {
            completed.push(unitId);
            events.push({ type: "ROUTE_COMPLETED", unitId, tick });
        }

        changes.push({ type: "UPDATE_UNIT", unit: moved.unit });
    }

    state.execution = execution;
    appendEvents(state, events);
    advanceBattlefield(state, changes);

    for (const unitId of completed) {
        removeUnitWithEffects(state, unitId, "SCRIPT", resources, tick);
    }
}

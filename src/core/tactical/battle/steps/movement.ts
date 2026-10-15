import type { BattlefieldChange } from "../../battlefield/contract.js";
import { canMove, hasRoutedLocomotion } from "../../unit/capability/locomotion/capability.js";
import { stepRoutedUnit } from "../../unit/capability/locomotion/step.js";
import * as units from "../../unit/query.js";
import type { Id } from "../../unit/unit.js";
import { changeAlternativeRoutes } from "./route-control.js";
import type { Command, Event } from "../contract.js";
import { removeUnitWithEffects } from "../execution/unit-lifecycle.js";
import {
    advanceBattlefield,
    appendEvents,
    battlefieldView,
    type State as BattleState,
} from "../state.js";

export function advanceRouteCommands(
    state: BattleState,
    commands: readonly Command[],
    tick: number,
): BattleState {
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
    state = { ...state, execution: changed.execution };
    state = appendEvents(
        state,
        changed.signals.map((signal) => ({ type: "ROUTE", ...signal, tick })),
    );
    state = advanceBattlefield(state, changed.changes);

    return state;
}

export function advanceMovement(
    state: BattleState,
    tick: number,
    {
        routeMoveMultiplier,
    }: {
        readonly routeMoveMultiplier: number;
    },
): BattleState {
    const battlefield = battlefieldView(state);
    let execution = state.execution;
    const changes: BattlefieldChange[] = [];
    const events: Event[] = [];
    const completed: Id[] = [];

    const candidates = units.filter(state, hasRoutedLocomotion);

    for (const ref of candidates.sort((left, right) => left.id - right.id)) {
        const unit = units.get(state, ref)!;
        const unitId = ref.id;

        const moved = stepRoutedUnit(unit, {
            tick,
            maps: battlefield.navigationMaps,
            fieldCache: battlefield.fieldCache,
            moveMultiplier: routeMoveMultiplier,
            queryContext: { unit, battlefield },
            movementAllowed: canMove(state, unit) && battlefield.blockerOf(unitId) === undefined,
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

    state = { ...state, execution };
    state = appendEvents(state, events);
    state = advanceBattlefield(state, changes);

    for (const unitId of completed) {
        state = removeUnitWithEffects(state, unitId, "SCRIPT");
    }

    return state;
}

import type { BattlefieldChange } from "../battlefield/runtime.js";
import { hasRoutedLocomotion } from "../unit/capability/locomotion/state.js";
import { hasAction } from "../unit/capability/action.js";
import { stepRoutedUnit } from "../unit/capability/locomotion/step.js";
import { changeAlternativeRoutes, type AlternativeRouteCommand } from "./route-control.js";
import type { BattleEvent } from "./contract.js";
import type { BattlePhase } from "./system.js";

export function createMovementSystem({ moveMultiplier }: { readonly moveMultiplier: number }): {
    readonly reroute: BattlePhase;
    readonly step: BattlePhase;
} {
    const reroute: BattlePhase = (input) => {
        const commands = input.commands.filter(
            (command): command is AlternativeRouteCommand =>
                command.type === "SET_ALTERNATIVE_ROUTE" ||
                command.type === "CLEAR_ALTERNATIVE_ROUTE",
        );
        const changed = changeAlternativeRoutes(
            (id) => input.battlefield.getUnit(id),
            commands,
            input.execution,
            input.tick,
        );

        return {
            state: undefined,
            changes: changed.changes,
            events: changed.signals.map((signal) => ({
                type: "ROUTE",
                ...signal,
                tick: input.tick,
            })),
            execution: changed.execution,
        };
    };

    const step: BattlePhase = (input) => {
        const { battlefield, tick } = input;
        let execution = input.execution;
        const changes: BattlefieldChange[] = [];
        const events: BattleEvent[] = [];

        for (const unitId of [...battlefield.unitIds].sort((left, right) => left - right)) {
            const unit = battlefield.getUnit(unitId)!;

            if (!hasRoutedLocomotion(unit)) {
                continue;
            }

            const moved = stepRoutedUnit(unit, {
                tick,
                maps: battlefield.navigationMaps,
                fieldCache: battlefield.fieldCache,
                moveMultiplier,
                movementAllowed:
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
                changes.push({ type: "REMOVE_UNIT", unitId, reason: "SCRIPT" });
                events.push({ type: "ROUTE_COMPLETED", unitId, tick });
            } else {
                changes.push({ type: "UPDATE_UNIT", unit: moved.unit });
            }
        }

        return { state: undefined, changes, events, execution };
    };

    return { reroute, step };
}

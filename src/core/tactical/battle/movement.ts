import type { BattlefieldChange } from "../battlefield/runtime.js";
import { hasRoutedLocomotion } from "../unit/locomotion/state.js";
import { stepRoutedUnit } from "../unit/locomotion/step.js";
import { changeAlternativeRoutes } from "./route-control.js";
import type { AlternativeRouteCommand } from "./route-control.js";
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
                movementAllowed: true,
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
            for (const outcome of moved.outcomes) {
                events.push({ type: "NAVIGATION", unitId, outcome, tick });
            }
            if (moved.unit.locomotion.mainRoute.route.progress.phase === "COMPLETED") {
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

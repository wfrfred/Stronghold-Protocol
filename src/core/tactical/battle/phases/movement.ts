import type { BattlefieldChange } from "../../battlefield/contract.js";
import type * as computation from "../../modifier/computation.js";
import type { ContributionFacts } from "../../unit/capability/contribution.js";
import { hasRoutedLocomotion } from "../../unit/capability/locomotion/capability.js";
import { hasAction } from "../../unit/capability/action/capability.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";
import { stepRoutedUnit } from "../../unit/capability/locomotion/step.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { changeAlternativeRoutes, type AlternativeRouteCommand } from "./route-control.js";
import type { Event } from "../contract.js";
import type { BattlePhaseInput, BattlePhaseOutput } from "../phase.js";
import { removeUnitWithEffects, type UnitLifecycleResources } from "../execution/unit-lifecycle.js";
import {
    combatWorkChanges,
    combatWorkEvents,
    createCombatWork,
    updateCombatUnits,
} from "../execution/work.js";

export interface MovementPhaseInput extends BattlePhaseInput {
    readonly movementAllowed?: (unitId: UnitId) => boolean;
}

export function applyRouteCommands(input: BattlePhaseInput): BattlePhaseOutput {
    const commands = input.commands.filter(
        (command): command is AlternativeRouteCommand =>
            command.type === "SET_ALTERNATIVE_ROUTE" || command.type === "CLEAR_ALTERNATIVE_ROUTE",
    );
    const changed = changeAlternativeRoutes(
        (id) => input.battlefield.getUnit(id),
        commands,
        input.execution,
        input.tick,
    );

    return {
        changes: changed.changes,
        events: changed.signals.map((signal) => ({
            type: "ROUTE",
            ...signal,
            tick: input.tick,
        })),
        execution: changed.execution,
    };
}

export function advanceMovement(
    input: MovementPhaseInput,
    { routeMoveMultiplier }: { readonly routeMoveMultiplier: number },
    resources: UnitLifecycleResources & {
        readonly computations: computation.Computations<ContributionFacts>;
    },
): BattlePhaseOutput {
    const { battlefield, tick } = input;
    let execution = input.execution;
    const changes: BattlefieldChange[] = [];
    const events: Event[] = [];
    const movedUnits: Unit[] = [];
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
                (input.movementAllowed?.(unitId) ?? true) &&
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

        movedUnits.push(moved.unit);
    }

    let work = updateCombatUnits(createCombatWork(battlefield, execution, battlefield), movedUnits);

    for (const unitId of completed) {
        work = removeUnitWithEffects(work, unitId, "SCRIPT", resources, tick);
    }

    return {
        changes: [...changes, ...combatWorkChanges(work)],
        events: [...events, ...combatWorkEvents(work)],
        execution: work.execution,
    };
}

import type { Seed } from "../core/common/rng.js";
import type { NavigationRequestId } from "../core/tactical/battlefield/navigation/request.js";
import type { NavigationOutcome } from "../core/tactical/battlefield/navigation/state.js";
import type { EnemyDefinition, RoutedEnemy } from "../core/tactical/unit/archetype/enemy.js";
import type { LocatedRouteSignal } from "../core/tactical/unit/capability/locomotion/route-control.js";
import {
    stepRoutedUnit,
    type RoutedLocomotionStepContext,
} from "../core/tactical/unit/capability/locomotion/step.js";

export type RoutedEnemyStepContext = RoutedLocomotionStepContext;

export interface RoutedEnemyStep<D extends EnemyDefinition = EnemyDefinition> {
    readonly enemy: RoutedEnemy<D>;
    readonly signals: readonly LocatedRouteSignal[];
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

export function stepRoutedEnemy<D extends EnemyDefinition>(
    enemy: RoutedEnemy<D>,
    context: RoutedEnemyStepContext,
): RoutedEnemyStep<D> {
    const step = stepRoutedUnit(enemy, context);

    return {
        enemy: step.unit,
        signals: step.signals,
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}

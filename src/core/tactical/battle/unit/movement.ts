import type { Seed } from "../../../common/rng.js";
import type { NavigationRequestId } from "../../navigation/request.js";
import type { NavigationOutcome } from "../../navigation/state.js";
import type { RoutedEnemy } from "./enemy.js";
import { stepRoutedLocomotion } from "./locomotion/execute.js";
import type { RoutedLocomotionStepContext } from "./locomotion/execute.js";

export type RoutedEnemyStepContext = RoutedLocomotionStepContext;

export interface RoutedEnemyStep {
    readonly enemy: RoutedEnemy;
    readonly rngState: Seed;
    readonly nextNavigationRequestId: NavigationRequestId;
    readonly outcomes: readonly NavigationOutcome[];
}

export function stepRoutedEnemy(enemy: RoutedEnemy, context: RoutedEnemyStepContext): RoutedEnemyStep {
    const step = stepRoutedLocomotion(enemy.locomotion, enemy.position, enemy.definition.locomotion.moveSpeed, context);
    return {
        enemy: {
            ...enemy,
            position: step.position,
            locomotion: step.state,
        },
        rngState: step.rngState,
        nextNavigationRequestId: step.nextNavigationRequestId,
        outcomes: step.outcomes,
    };
}

import type { BattlefieldChange } from "../battlefield/contract.js";
import type { BattlefieldRuntime } from "../battlefield/runtime.js";
import { advanceMovement, applyRouteCommands } from "./phases/movement.js";
import { advanceBlocking } from "./phases/blocking.js";
import { createCombatSystem } from "./phases/combat.js";
import { advanceDeployment } from "./phases/deployment.js";
import { instantiateUnitPlacement } from "./creation/placement.js";
import { instantiateMechanismPlacement } from "./creation/mechanism.js";
import { instantiateNavigationModifierPlacement } from "./creation/navigation-modifier.js";
import { createSpawnScheduleDefinition } from "./schedule/definition.js";
import {
    changePredefinedInstances,
    createPredefinedSystem,
    type PredefinedPresence,
} from "./predefined.js";
import type { Input } from "./contract.js";
import { createSpawnScheduleExecution, type SpawnScheduleExecution } from "./schedule/state.js";
import { advanceSpawning, resolveSpawning } from "./phases/spawning.js";
import type { BattleExecutionState } from "./execution/state.js";
import type { BattlePhase, BattlePhaseInput, BattlePhaseOutput } from "./phase.js";
import { CombatResources } from "./resources.js";
import type { compileAction } from "../unit/capability/action/compile.js";
import { advanceEffectSources } from "./phases/effect-sources.js";
import type { ActionExecutionState } from "../unit/capability/action/process.js";
import { createProjectileSystem } from "./phases/projectiles.js";
import type { ProjectileState } from "../battlefield/projectile/state.js";
import { withProjectileOperations } from "../battlefield/projectile/operations.js";
import { advanceElements } from "./phases/elemental.js";
import { advanceSkills } from "./phases/skills.js";

export interface BattleResources {
    readonly combat?: CombatResources;
    readonly compileAction?: typeof compileAction;
}

export interface BattlePhaseState {
    readonly predefined: readonly PredefinedPresence[];
    readonly schedule: SpawnScheduleExecution;
    readonly actionExecution: ActionExecutionState;
    readonly projectiles: ProjectileState;
}

function statefulPhase<K extends keyof BattlePhaseState>(
    slot: K,
    phase: BattlePhase<BattlePhaseState[K]>,
): BattlePhase<BattlePhaseState> {
    return (input, phaseState) => {
        const phaseResult = phase(input, phaseState[slot]);

        return {
            ...phaseResult,
            state:
                phaseResult.state === phaseState[slot]
                    ? phaseState
                    : { ...phaseState, [slot]: phaseResult.state },
        };
    };
}

function statelessPhase(
    advance: (input: BattlePhaseInput, state: BattlePhaseState) => BattlePhaseOutput,
): BattlePhase<BattlePhaseState> {
    return (input, state) => ({ ...advance(input, state), state });
}

export function createBattlePhases(input: Input, resources: BattleResources = {}) {
    const combatResources = (resources.combat ?? new CombatResources()).seal();
    const predefined = createPredefinedSystem(input.predefines, combatResources);
    const scheduleDefinition = createSpawnScheduleDefinition(input.schedule);
    const movementOptions = { routeMoveMultiplier: input.routeMoveMultiplier };
    const combat = createCombatSystem(combatResources, resources.compileAction);
    const projectiles = createProjectileSystem(combatResources);

    const prepare: BattlePhase<readonly PredefinedPresence[]> = (input, state) => {
        const prepared = predefined.step(input, state);

        return {
            ...prepared,
            changes: [
                { type: "EXPIRE_NAVIGATION_MODIFIERS", tick: input.tick },
                ...prepared.changes,
            ],
        };
    };

    const act: BattlePhase<BattlePhaseState> = (input, state) => {
        const advanced = withProjectileOperations(
            state.projectiles,
            combatResources.projectiles,
            input.tick,
            (operations) =>
                combat.step({ ...input, projectiles: operations }, state.actionExecution),
        );

        return {
            ...advanced.result,
            state: {
                ...state,
                actionExecution: advanced.result.state,
                projectiles: advanced.state,
            },
        };
    };

    const phases = Object.freeze([
        statefulPhase("predefined", prepare),
        statefulPhase("actionExecution", combat.prepare),
        statelessPhase((input) => advanceDeployment(input, combatResources)),
        statefulPhase("schedule", advanceSpawning),
        statelessPhase((input) => advanceElements(input, combatResources)),
        statelessPhase((input) => advanceSkills(input, combatResources)),
        statelessPhase((input) => advanceEffectSources(input, combatResources)),
        statelessPhase(applyRouteCommands),
        statelessPhase(advanceBlocking),
        act,
        statefulPhase("projectiles", projectiles.step),
        statelessPhase((input, state) =>
            advanceMovement(
                {
                    ...input,
                    movementAllowed: (unitId) =>
                        combat.allowsMovement(state.actionExecution, unitId),
                },
                movementOptions,
                combatResources,
            ),
        ),
        statelessPhase((input) => advanceEffectSources(input, combatResources)),
        statelessPhase(advanceBlocking),
        statefulPhase("predefined", predefined.resolve),
        statefulPhase("schedule", resolveSpawning),
    ]);

    return {
        phases,
        combatResources,

        initialize(battlefield: BattlefieldRuntime, execution: BattleExecutionState) {
            const initialChanges: BattlefieldChange[] = [];
            const initialUnitIds: number[] = [];
            const initialMechanismIds: number[] = [];

            for (const placement of input.initialUnits) {
                const instantiated = instantiateUnitPlacement(placement, execution, 0);

                initialChanges.push(...instantiated.changes);
                initialUnitIds.push(instantiated.unit.id);
                execution = instantiated.execution;
            }

            for (const placement of input.initialMechanisms) {
                const instantiated = instantiateMechanismPlacement(
                    placement,
                    execution,
                    initialUnitIds,
                );
                initialChanges.push(...instantiated.changes);
                initialMechanismIds.push(instantiated.mechanism.id);
                execution = instantiated.execution;
            }
            for (const placement of input.initialNavigationModifiers) {
                const instantiated = instantiateNavigationModifierPlacement(
                    placement,
                    execution,
                    initialUnitIds,
                    initialMechanismIds,
                );
                initialChanges.push(...instantiated.changes);
                execution = instantiated.execution;
            }

            const initialized = changePredefinedInstances(
                input.predefines,
                predefined.createState(),
                input.predefines
                    .filter((definition) => definition.initiallyPresent)
                    .map((definition) => ({
                        type: "APPEAR_PREDEFINED",
                        definitionId: definition.id,
                    })),
                execution,
            );

            battlefield.apply([...initialChanges, ...initialized.changes]);

            const preparedSources = advanceEffectSources(
                {
                    battlefield: battlefield.view,
                    tick: 0,
                    commands: [],
                    execution: initialized.execution,
                    removedUnits: [],
                },
                combatResources,
            );
            battlefield.commitOwned(preparedSources.changes);

            const phaseState: BattlePhaseState = {
                predefined: initialized.presence,
                schedule: createSpawnScheduleExecution(scheduleDefinition),
                actionExecution: combat.createState(),
                projectiles: projectiles.createState(),
            };

            return { phaseState, execution: preparedSources.execution };
        },
    };
}

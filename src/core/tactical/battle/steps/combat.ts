import {
    type ActionExecutionWork,
    actionExecutionsBySource,
} from "../../unit/capability/action/internal/executions.js";
import { compileAction } from "../../unit/capability/action/compile.js";
import type { ActionStartResources } from "../../unit/capability/action/execution.js";
import { startActionInWork } from "../../unit/capability/action/internal/execution.js";
import {
    cancelActionExecutionInWork,
    resumeActionExecutionInWork,
} from "../../unit/capability/action/internal/process.js";
import type { CompiledAction } from "../../unit/capability/action/compiled.js";
import {
    actionExecutionPermissions,
    type ActionExecution,
    type ActionExecutionState,
    type CompiledActionSegment,
} from "../../unit/capability/action/process.js";
import { prepareCombatEffects, retireCombatUnit } from "../execution/unit-lifecycle.js";
import { CombatResources } from "../resources.js";
import {
    advanceBattlefield,
    battlefieldView,
    getUnit,
    type BattleState,
} from "../execution/context.js";
import { hasAction, type ActionDefinition } from "../../unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import type { UnitId } from "../../unit/unit.js";
import type { Command } from "../contract.js";
import {
    withProjectileOperations,
    type ProjectileOperations,
} from "../../battlefield/projectile/operations.js";
import { hasSkill } from "../../unit/capability/skill/capability.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";

export function createCombat(
    resources = new CombatResources(),
    compile: typeof compileAction = compileAction,
) {
    const compiledActions = new WeakMap<ActionDefinition, CompiledAction>();

    const compiledAction = (definition: ActionDefinition): CompiledAction => {
        let compiled = compiledActions.get(definition);

        if (compiled === undefined) {
            const candidate = compile(definition, resources);

            if (candidate.definition !== definition) {
                throw new TypeError("compiled action must retain its definition association");
            }

            compiled = candidate;
            compiledActions.set(definition, compiled);
        }

        return compiled;
    };

    const segmentsOf = (execution: ActionExecution): readonly CompiledActionSegment[] =>
        compiledAction(execution.definition).program;

    const mayStart = (executions: ActionExecutionWork, unitId: UnitId): boolean =>
        executions
            .forSource(unitId)
            .every(
                (execution) =>
                    actionExecutionPermissions(execution, segmentsOf(execution)).allowNewAction,
            );

    const executionsOf = (state: BattleState): ActionExecutionWork => {
        if (state.actionExecutions === undefined) {
            throw new TypeError("combat requires action execution state");
        }

        return state.actionExecutions;
    };

    const prepare = (state: BattleState, commands: readonly Command[], tick: number): void => {
        const executions = executionsOf(state);
        prepareCombatEffects(state, tick, resources);

        for (const command of commands) {
            if (command.type !== "CANCEL_ACTION_EXECUTION") {
                continue;
            }

            cancelActionExecutionInWork(
                state,
                executions,
                { executionId: command.executionId, tick },
                resources,
            );
        }
    };

    const advanceActions = (
        state: BattleState,
        tick: number,
        projectiles: ProjectileOperations,
    ): void => {
        const battlefield = battlefieldView(state);
        const executions = executionsOf(state);
        const actionResources: ActionStartResources = {
            computations: resources.computations,
            effects: resources.effects,
            effectBindings: resources.effectBindings,
            effectLifecycle: resources.effectLifecycle,
            actionRelease: resources.actionRelease,
            completeAttack: resources.completeAttack,
            projectileOperations: projectiles,
        };
        const ids = [
            ...new Set([
                ...battlefield.unitIds,
                ...executions.result().executions.map(({ sourceUnitId }) => sourceUnitId),
            ]),
        ].sort((left, right) => left - right);
        prepareCombatEffects(state, tick, resources);

        for (const id of ids) {
            const unit = getUnit(state, id);

            if (unit !== undefined && hasVitality(unit) && unit.vitality.hp <= 0) {
                retireCombatUnit(state, id, resources, tick);
            }
        }

        for (const id of ids) {
            for (const execution of executions.forSource(id)) {
                resumeActionExecutionInWork(
                    state,
                    executions,
                    { executionId: execution.id, segments: segmentsOf(execution), tick },
                    actionResources,
                );
            }

            const unit = getUnit(state, id);

            if (
                unit === undefined ||
                !hasAction(unit) ||
                !isSpatiallyPresent(unit) ||
                hasStatusFlag(unit, "STUNNED")
            ) {
                continue;
            }

            startActionInWork(
                state,
                executions,
                {
                    sourceUnitId: id,
                    compiled: compiledAction(
                        hasSkill(unit) && unit.skill.active !== null
                            ? (unit.definition.skill.activeAction ??
                                  unit.definition.action.normalAction)
                            : unit.definition.action.normalAction,
                    ),
                    tick,
                    mayStart: mayStart(executions, id),
                },
                actionResources,
            );
        }
    };

    const advance = (state: BattleState, tick: number): void => {
        const launched = withProjectileOperations(
            battlefieldView(state),
            state.execution.nextProjectileId,
            resources.projectiles,
            tick,
            (projectiles) => {
                advanceActions(state, tick, projectiles);

                return undefined;
            },
        );
        advanceBattlefield(state, launched.changes);
        state.execution = { ...state.execution, nextProjectileId: launched.nextProjectileId };
    };

    return {
        prepare,
        advance,
        allowsMovement: (state: ActionExecutionState, unitId: UnitId) =>
            (actionExecutionsBySource(state).get(unitId) ?? []).every(
                (execution) =>
                    !actionExecutionPermissions(execution, segmentsOf(execution)).blockingMovement,
            ),
    };
}

import {
    ActionExecutionWork,
    actionExecutionsBySource,
} from "../../unit/capability/action/internal/executions.js";
import { compileAction } from "../../unit/capability/action/compile.js";
import type { ActionStartResources } from "../../unit/capability/action/execution.js";
import { startActionInWork } from "../../unit/capability/action/internal/execution.js";
import {
    cancelActionExecutionInWork,
    resumeActionExecutionInWork,
} from "../../unit/capability/action/internal/process.js";
import { ownCompiledAction, type CompiledAction } from "../../unit/capability/action/program.js";
import {
    actionExecutionPermissions,
    type ActionExecution,
    type ActionExecutionState,
    type CompiledActionSegment,
} from "../../unit/capability/action/process.js";
import { prepareCombatEffects, retireCombatUnit } from "../execution/unit-lifecycle.js";
import { CombatResources } from "../resources.js";
import {
    combatWorkEvents,
    combatWorkChanges,
    createCombatWork,
    getCombatUnit,
} from "../execution/work.js";
import { hasAction, type ActionDefinition } from "../../unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import type { UnitId } from "../../unit/unit.js";
import type { BattlefieldChange, BattlefieldView } from "../../battlefield/contract.js";
import type { Command, Event } from "../contract.js";
import type { BattleExecutionState } from "../execution/state.js";
import {
    withProjectileOperations,
    type ProjectileOperations,
} from "../../battlefield/projectile/operations.js";
import { hasSkill } from "../../unit/capability/skill/capability.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";

interface CombatPreparationInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly commands: readonly Command[];
    readonly execution: BattleExecutionState;
}

interface CombatAdvanceInput {
    readonly battlefield: BattlefieldView;
    readonly tick: number;
    readonly execution: BattleExecutionState;
}

interface CombatAdvanceResult {
    readonly actionExecution: ActionExecutionState;
    readonly changes: readonly BattlefieldChange[];
    readonly events: readonly Event[];
    readonly execution: BattleExecutionState;
}

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

            compiled = ownCompiledAction(candidate);
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

    const prepare = (
        input: CombatPreparationInput,
        state: ActionExecutionState,
    ): CombatAdvanceResult => {
        let executions: ActionExecutionWork | undefined;
        let work = prepareCombatEffects(
            createCombatWork(input.battlefield, input.execution, input.battlefield),
            input.tick,
            resources,
        );

        for (const command of input.commands) {
            if (command.type !== "CANCEL_ACTION_EXECUTION") {
                continue;
            }

            executions ??= new ActionExecutionWork(state);
            const cancelled = cancelActionExecutionInWork(
                work,
                executions,
                { executionId: command.executionId, tick: input.tick },
                resources,
            );
            work = cancelled.work;
        }

        return {
            actionExecution: executions?.result() ?? state,
            changes: combatWorkChanges(work),
            events: combatWorkEvents(work),
            execution: work.execution,
        };
    };

    const advanceActions = (
        input: CombatAdvanceInput,
        state: ActionExecutionState,
        projectiles: ProjectileOperations,
    ): CombatAdvanceResult => {
        const { battlefield, tick } = input;
        const executions = new ActionExecutionWork(state);
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
                ...state.executions.map(({ sourceUnitId }) => sourceUnitId),
            ]),
        ].sort((left, right) => left - right);
        let work = prepareCombatEffects(
            createCombatWork(battlefield, input.execution, battlefield),
            tick,
            resources,
        );

        for (const id of ids) {
            const unit = getCombatUnit(work, id);

            if (unit !== undefined && hasVitality(unit) && unit.vitality.hp <= 0) {
                work = retireCombatUnit(work, id, resources, tick);
            }
        }

        for (const id of ids) {
            for (const execution of executions.forSource(id)) {
                const resumed = resumeActionExecutionInWork(
                    work,
                    executions,
                    { executionId: execution.id, segments: segmentsOf(execution), tick },
                    actionResources,
                );
                work = resumed.work;
            }

            const unit = getCombatUnit(work, id);

            if (
                unit === undefined ||
                !hasAction(unit) ||
                !isSpatiallyPresent(unit) ||
                hasStatusFlag(unit, "STUNNED")
            ) {
                continue;
            }

            work = startActionInWork(
                work,
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

        return {
            actionExecution: executions.result(),
            changes: combatWorkChanges(work),
            events: combatWorkEvents(work),
            execution: work.execution,
        };
    };

    const advance = (
        input: CombatAdvanceInput,
        state: ActionExecutionState,
    ): CombatAdvanceResult => {
        const launched = withProjectileOperations(
            input.battlefield,
            input.execution,
            resources.projectiles,
            input.tick,
            (projectiles) => advanceActions(input, state, projectiles),
        );

        return {
            ...launched.result,
            changes: [...launched.result.changes, ...launched.changes],
            execution: {
                ...launched.result.execution,
                nextProjectileId: launched.execution.nextProjectileId,
            },
        };
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

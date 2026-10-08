import {
    ActionExecutionWork,
    actionExecutionsBySource,
} from "../../unit/capability/action/internal/executions.js";
import { compileAction } from "../../unit/capability/action/compile.js";
import { startActionInWork } from "../../unit/capability/action/execution.js";
import { ownCompiledAction, type CompiledAction } from "../../unit/capability/action/program.js";
import {
    actionExecutionPermissions,
    cancelActionExecutionInWork,
    createActionExecutionState,
    resumeActionExecutionInWork,
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
import type { BattlePhase, BattlePhaseInput } from "../system.js";
import type { ProjectileOperations } from "../../battlefield/projectile/operations.js";
import { hasSkill } from "../../unit/capability/skill/capability.js";
import { hasStatusFlag } from "../../unit/capability/status/capability.js";

export interface CombatPhaseInput extends BattlePhaseInput {
    readonly projectiles?: ProjectileOperations;
}

export function createCombatSystem(
    resources = new CombatResources(),
    compile: typeof compileAction = compileAction,
): {
    createState(): ActionExecutionState;
    readonly prepare: BattlePhase<ActionExecutionState>;
    readonly step: BattlePhase<ActionExecutionState, CombatPhaseInput>;
    allowsMovement(state: ActionExecutionState, unitId: UnitId): boolean;
} {
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

    const prepare: BattlePhase<ActionExecutionState> = (input, state) => {
        let executions: ActionExecutionWork | undefined;
        let work = prepareCombatEffects(
            createCombatWork(input.battlefield, input.execution, input.battlefield),
            input.tick,
            resources,
        );

        for (const command of input.commands) {
            if (command.type === "CANCEL_ACTION_EXECUTION") {
                executions ??= new ActionExecutionWork(state);
                const cancelled = cancelActionExecutionInWork(
                    work,
                    executions,
                    command.executionId,
                    resources,
                    input.tick,
                );
                work = cancelled.work;
            }
        }

        return {
            state: executions?.result() ?? state,
            changes: combatWorkChanges(work),
            events: combatWorkEvents(work),
            execution: work.execution,
        };
    };

    const step: BattlePhase<ActionExecutionState, CombatPhaseInput> = (input, state) => {
        const { battlefield, tick } = input;
        const executions = new ActionExecutionWork(state);
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
                    execution.id,
                    segmentsOf(execution),
                    tick,
                    resources,
                    input.projectiles,
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
                id,
                compiledAction(
                    hasSkill(unit) && unit.skill.active !== null
                        ? (unit.definition.skill.activeAction ??
                              unit.definition.action.normalAction)
                        : unit.definition.action.normalAction,
                ),
                tick,
                resources,
                mayStart(executions, id),
                input.projectiles,
            );
        }

        return {
            state: executions.result(),
            changes: combatWorkChanges(work),
            events: combatWorkEvents(work),
            execution: work.execution,
        };
    };

    return {
        createState: createActionExecutionState,
        prepare,
        step,
        allowsMovement: (state, unitId) =>
            (actionExecutionsBySource(state).get(unitId) ?? []).every(
                (execution) =>
                    !actionExecutionPermissions(execution, segmentsOf(execution)).blockingMovement,
            ),
    };
}

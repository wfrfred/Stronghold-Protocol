import { compileAction } from "../../unit/capability/action/compile.js";
import { startAction, type ActionStartResources } from "../../unit/capability/action/execution.js";
import {
    cancelActionExecution,
    resumeActionExecution,
    actionExecutionPermissions,
    type ActionExecution,
    type ActionExecutionState,
    type CompiledActionSegment,
} from "../../unit/capability/action/process.js";
import type { CompiledAction } from "../../unit/capability/action/compiled.js";
import { retireCombatUnit } from "../execution/unit-lifecycle.js";
import { CombatResources } from "../resources.js";
import { battlefieldView, getUnit, type BattleState } from "../state.js";
import { emptyCall, type CallContext } from "../execution/call.js";
import { hasAction, type ActionDefinition } from "../../unit/capability/action/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import { hasVitality } from "../../unit/capability/vitality/capability.js";
import type { UnitId } from "../../unit/unit.js";
import type { Command } from "../contract.js";
import { createProjectileOperations } from "../../battlefield/projectile/operations.js";
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
            compiled = compile(definition, resources);

            if (compiled.definition !== definition) {
                throw new TypeError("compiled action must retain its definition association");
            }

            compiledActions.set(definition, compiled);
        }

        return compiled;
    };

    const segmentsOf = (execution: ActionExecution): readonly CompiledActionSegment[] =>
        compiledAction(execution.definition).program;
    const forSource = (state: ActionExecutionState, unitId: UnitId): readonly ActionExecution[] =>
        state.executions.filter((execution) => execution.sourceUnitId === unitId);
    const mayStart = (state: ActionExecutionState, unitId: UnitId): boolean =>
        forSource(state, unitId).every(
            (execution) =>
                actionExecutionPermissions(execution, segmentsOf(execution)).allowNewAction,
        );

    const prepare = (
        state: BattleState,
        commands: readonly Command[],
        tick: number,
        call: CallContext = emptyCall,
    ): BattleState => {
        for (const command of commands) {
            if (command.type === "CANCEL_ACTION_EXECUTION") {
                state = cancelActionExecution(
                    state,
                    { executionId: command.executionId, tick },
                    call,
                ).state;
            }
        }

        return state;
    };

    const advance = (
        state: BattleState,
        tick: number,
        call: CallContext = emptyCall,
    ): BattleState => {
        const actionResources: ActionStartResources = {
            completeAttack: resources.completeAttack,
            projectileOperations: createProjectileOperations(resources.projectiles, tick),
        };
        const ids = [
            ...new Set([
                ...battlefieldView(state).unitIds,
                ...state.actionExecutions.executions.map(({ sourceUnitId }) => sourceUnitId),
            ]),
        ].sort((left, right) => left - right);

        for (const id of ids) {
            const unit = getUnit(state, id);

            if (unit !== undefined && hasVitality(unit) && unit.vitality.hp <= 0) {
                state = retireCombatUnit(state, id, resources, tick, call);
            }
        }
        for (const id of ids) {
            for (const execution of forSource(state.actionExecutions, id)) {
                state = resumeActionExecution(
                    state,
                    { executionId: execution.id, segments: segmentsOf(execution), tick },
                    actionResources,
                    call,
                ).state;
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

            state = startAction(
                state,
                {
                    sourceUnitId: id,
                    compiled: compiledAction(
                        hasSkill(unit) && unit.skill.active !== null
                            ? (unit.definition.skill.activeAction ??
                                  unit.definition.action.normalAction)
                            : unit.definition.action.normalAction,
                    ),
                    tick,
                    mayStart: mayStart(state.actionExecutions, id),
                },
                actionResources,
                call,
            );
        }

        return state;
    };

    return {
        prepare,
        advance,
        allowsMovement: (state: ActionExecutionState, unitId: UnitId) =>
            forSource(state, unitId).every(
                (execution) =>
                    !actionExecutionPermissions(execution, segmentsOf(execution)).blockingMovement,
            ),
    };
}

import type { BattleEvent } from "../battle/contract.js";
import { selectTargets } from "../targeting/select.js";
import {
    hasAction,
    type Action,
    type ActionDefinition,
    type ActingUnitDefinition,
    type TargetBindingId,
} from "../unit/capability/action.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { resolveMaxHp } from "./attributes.js";
import { compileEffect, type CompiledEffect } from "./compile-effect.js";
import { effectPurposes, type EffectDefinition } from "./effect.js";
import { CombatResources } from "./resources.js";
import { compileTargeting, type CombatTargetingView } from "./targeting.js";
import {
    appendCombatEvents,
    combatWorkResult,
    combatWorkView,
    createCombatWork,
    getCombatUnit,
    updateCombatUnit,
    type CombatWork,
} from "./work.js";

export interface ActionProgramContext {
    readonly work: CombatWork;
    readonly sourceUnitId: UnitId;
    readonly tick: number;
    readonly bindings: ReadonlyMap<TargetBindingId, readonly UnitId[]>;
}

export type ActionProgramStep = (context: ActionProgramContext) => ActionProgramContext;

export interface CompiledAction {
    readonly definition: ActionDefinition;
    readonly bind: ActionProgramStep;
    readonly program: readonly ActionProgramStep[];
}

export interface ActionStep {
    readonly units: readonly Unit[];
    readonly removedUnitIds: readonly UnitId[];
    readonly events: readonly BattleEvent[];
}

export interface ActionStepContext {
    readonly battlefield: CombatTargetingView;
    readonly tick: number;
}

export function compileAction(
    definition: ActionDefinition,
    resources = new CombatResources(),
    compile: (effect: EffectDefinition) => CompiledEffect = (effect) =>
        compileEffect(effect, resources),
): CompiledAction {
    const groups = definition.targetGroups.map((group) => ({
        id: group.id,
        targeting: compileTargeting(
            group.targeting,
            group.effects.flatMap(effectPurposes),
            (unit, context) => resolveMaxHp(unit, createCombatWork(context.battlefield), resources),
        ),
        effects: group.effects.map(compile),
    }));

    const applyTo =
        (
            effect: CompiledEffect,
            ids: (context: ActionProgramContext) => readonly UnitId[],
        ): ActionProgramStep =>
        (context) => {
            let { work } = context;

            for (const targetUnitId of ids(context)) {
                work = effect({
                    work,
                    sourceUnitId: context.sourceUnitId,
                    targetUnitId,
                    tick: context.tick,
                });
            }

            return { ...context, work };
        };

    const program = groups.flatMap((group) =>
        group.effects.map((effect) =>
            applyTo(effect, (context) => context.bindings.get(group.id)!),
        ),
    );

    for (const { receiver, effect } of definition.followUps) {
        const ids =
            receiver.type === "SOURCE"
                ? (context: ActionProgramContext) => [context.sourceUnitId]
                : (context: ActionProgramContext) => context.bindings.get(receiver.bindingId)!;

        program.push(applyTo(compile(effect), ids));
    }

    return {
        definition,
        bind: (context) => {
            const source = getCombatUnit(context.work, context.sourceUnitId)!;
            const query = { source, battlefield: combatWorkView(context.work) };
            const bindings = new Map<TargetBindingId, readonly UnitId[]>();

            for (const group of groups) {
                bindings.set(
                    group.id,
                    selectTargets(query, group.targeting).map((unit) => unit.id),
                );
            }

            return { ...context, bindings };
        },
        program,
    };
}

export function executeAction(
    work: CombatWork,
    sourceUnitId: UnitId,
    compiled: CompiledAction,
    tick: number,
): CombatWork {
    const source = getCombatUnit(work, sourceUnitId);

    if (source === undefined || !hasAction(source)) {
        return work;
    }

    let context = compiled.bind({ work, sourceUnitId, tick, bindings: new Map() });
    const targetUnitId = context.bindings.get(compiled.definition.triggerBindingId)![0] ?? null;
    const current = getCombatUnit(context.work, sourceUnitId);

    if (current === undefined || !hasAction(current)) {
        return context.work;
    }

    let acting = current;

    if (targetUnitId !== current.action.targetUnitId) {
        acting = { ...current, action: { ...current.action, targetUnitId } };
    }

    work = updateCombatUnit(context.work, acting);

    if (
        targetUnitId === null ||
        tick < acting.action.readyAtTick ||
        tick < acting.action.recoveryUntilTick
    ) {
        return work;
    }

    const { definition } = compiled;
    const executing = {
        ...acting,
        action: {
            ...acting.action,
            readyAtTick: tick + definition.intervalTicks,
            recoveryUntilTick: tick + definition.recoveryTicks,
        },
    };

    work = updateCombatUnit(work, executing);
    work = appendCombatEvents(work, [{ type: "ACTION", sourceUnitId, targetUnitId, tick }]);
    context = { ...context, work };

    for (const step of compiled.program) {
        context = step(context);
    }

    return context.work;
}

export function stepAction(
    source: Unit<ActingUnitDefinition> & Action,
    compiled: CompiledAction,
    context: ActionStepContext,
): ActionStep {
    const work = executeAction(
        updateCombatUnit(createCombatWork(context.battlefield), source),
        source.id,
        compiled,
        context.tick,
    );
    const { units, removedUnitIds, events } = combatWorkResult(work);

    return { units, removedUnitIds, events };
}

import { selectTargets } from "../targeting/select.js";
import type { CompiledTargeting } from "../targeting/query.js";
import type {
    Action,
    ActionDefinition,
    ActingUnitDefinition,
    TargetBindingId,
} from "../unit/capability/action.js";
import { hasVitality } from "../unit/capability/vitality.js";
import type { Unit, UnitId } from "../unit/unit.js";
import { damageUnit } from "./damage.js";
import { effectPurposes, type EffectDefinition } from "./effect.js";
import type { CombatEvent } from "./event.js";
import { healUnit } from "./healing.js";
import {
    compileTargeting,
    type CombatTargetingView,
    type CombatTargetQueryContext,
} from "./targeting.js";

interface CompiledTargetGroup {
    readonly id: TargetBindingId;
    readonly targeting: CompiledTargeting<CombatTargetQueryContext>;
    readonly effects: readonly EffectDefinition[];
}

export interface CompiledAction {
    readonly definition: ActionDefinition;
    readonly targetGroups: readonly CompiledTargetGroup[];
}

export interface ActionStep {
    readonly units: readonly Unit[];
    readonly removedUnitIds: readonly UnitId[];
    readonly events: readonly CombatEvent[];
}

export interface ActionStepContext {
    readonly battlefield: CombatTargetingView;
    readonly tick: number;
}

export function compileAction(definition: ActionDefinition): CompiledAction {
    return {
        definition,
        targetGroups: definition.targetGroups.map((group) => ({
            id: group.id,
            targeting: compileTargeting(group.targeting, group.effects.flatMap(effectPurposes)),
            effects: group.effects,
        })),
    };
}

function resolveEffect(
    effect: EffectDefinition,
    sourceUnitId: UnitId,
    target: Unit,
    tick: number,
): { readonly unit: Unit; readonly event: CombatEvent } | undefined {
    if (!hasVitality(target) || target.vitality.hp <= 0) {
        return undefined;
    }

    switch (effect.type) {
        case "DAMAGE": {
            const result = damageUnit(target, effect.power, effect.damageType);

            return {
                unit: result.unit,
                event: {
                    type: "DAMAGE",
                    sourceUnitId,
                    targetUnitId: target.id,
                    damageType: effect.damageType,
                    amount: result.amount,
                    hp: result.unit.vitality.hp,
                    tick,
                },
            };
        }

        case "HEAL": {
            const result = healUnit(target, effect.power, effect.ignoreHealFree);

            return {
                unit: result.unit,
                event: {
                    type: "HEAL",
                    sourceUnitId,
                    targetUnitId: target.id,
                    amount: result.amount,
                    hp: result.unit.vitality.hp,
                    tick,
                },
            };
        }
    }
}

export function stepAction(
    source: Unit<ActingUnitDefinition> & Action,
    compiled: CompiledAction,
    context: ActionStepContext,
): ActionStep {
    const bindings = new Map<TargetBindingId, readonly UnitId[]>();
    const queryContext = { source, battlefield: context.battlefield };

    for (const group of compiled.targetGroups) {
        bindings.set(
            group.id,
            selectTargets(queryContext, group.targeting).map((unit) => unit.id),
        );
    }

    const targetUnitId = bindings.get(compiled.definition.triggerBindingId)![0] ?? null;
    let acting = source;

    if (targetUnitId !== source.action.targetUnitId) {
        acting = { ...source, action: { ...source.action, targetUnitId } };
    }

    if (
        targetUnitId === null ||
        context.tick < acting.action.readyAtTick ||
        context.tick < acting.action.recoveryUntilTick
    ) {
        return {
            units: acting === source ? [] : [acting],
            removedUnitIds: [],
            events: [],
        };
    }

    const updates = new Map<UnitId, Unit>();
    const removed = new Set<UnitId>();
    const events: CombatEvent[] = [
        {
            type: "ACTION",
            sourceUnitId: source.id,
            targetUnitId,
            tick: context.tick,
        },
    ];
    const { definition } = compiled;
    const executing = {
        ...acting,
        action: {
            ...acting.action,
            readyAtTick: context.tick + definition.intervalTicks,
            recoveryUntilTick: context.tick + definition.recoveryTicks,
        },
    };
    updates.set(source.id, executing);

    const apply = (effect: EffectDefinition, targetId: UnitId): void => {
        if (removed.has(targetId)) {
            return;
        }

        const target = updates.get(targetId) ?? context.battlefield.getUnit(targetId);

        if (target === undefined) {
            return;
        }

        const resolved = resolveEffect(effect, source.id, target, context.tick);

        if (resolved === undefined) {
            return;
        }
        if (resolved.unit !== target) {
            updates.set(targetId, resolved.unit);
        }
        if (hasVitality(resolved.unit) && resolved.unit.vitality.hp <= 0) {
            removed.add(targetId);
        }

        events.push(resolved.event);
    };

    for (const group of compiled.targetGroups) {
        for (const effect of group.effects) {
            for (const targetId of bindings.get(group.id)!) {
                apply(effect, targetId);
            }
        }
    }
    for (const { receiver, effect } of definition.followUps) {
        const ids = receiver.type === "SOURCE" ? [source.id] : bindings.get(receiver.bindingId)!;

        for (const id of ids) {
            apply(effect, id);
        }
    }

    return {
        units: [...updates.values()],
        removedUnitIds: [...removed],
        events,
    };
}

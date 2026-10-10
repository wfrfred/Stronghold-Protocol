import type { UnitId } from "../../../unit.js";
import type { EffectRef, EffectInstanceValue } from "../../effects/instance.js";
import { EffectDispatchScope, participatingEffect } from "../../effects/dispatch.js";
import { finalizeFinishedEffects } from "../../effects/lifecycle.js";
import type { BattleState } from "../../../../battle/execution/context.js";
import { withVitalityHookContext, vitalityHookFacts, type DispatchResult } from "../hook.js";
import type { DamageOperands, DamageReport, DamageRequest, PendingDamage } from "./contract.js";
import type {
    AmountStage,
    CompiledDamageRules,
    DamageHookInvocation,
    DamageHookStage,
    DamageResourceServices,
    FormulaStage,
} from "./resources.js";

interface CompiledStage<V> {
    readonly priority: number;
    readonly apply: (context: DamageHookInvocation, value: V) => DispatchResult<V>;
}

function dispatchStage<V>(
    work: BattleState,
    request: DamageRequest,
    ownerUnitId: UnitId | null,
    stage: DamageHookStage,
    value: V,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
    select: (rules: CompiledDamageRules) => CompiledStage<V> | undefined,
): V {
    if (ownerUnitId === null) {
        return value;
    }

    const facts = vitalityHookFacts(() => work);
    dispatch.withCandidates(facts, ownerUnitId, (identities) => {
        const candidates = identities
            .flatMap((ref) => {
                const instance = facts.getEffect(ref);
                const hook =
                    instance === undefined ? undefined : select(resources.damage.get(instance));

                return instance === undefined || hook === undefined
                    ? []
                    : [{ ref, sequence: instance.acquiredSequence, hook }];
            })
            .sort(
                (left, right) =>
                    right.hook.priority - left.hook.priority ||
                    left.sequence - right.sequence ||
                    left.ref.effectId - right.ref.effectId,
            );

        const isGroupWinner = (instance: EffectInstanceValue, ref: EffectRef): boolean => {
            const group = resources.damage.get(instance).group;

            if (group === undefined) {
                return true;
            }

            return !identities.some((otherAddress) => {
                const other = participatingEffect(facts, otherAddress);

                if (other === undefined || other.id === ref.effectId) {
                    return false;
                }

                const rules = resources.damage.get(other);
                const otherGroup = rules.group;

                return (
                    rules[stage] !== undefined &&
                    otherGroup?.id === group.id &&
                    (otherGroup.strength > group.strength ||
                        (otherGroup.strength === group.strength &&
                            (other.acquiredSequence < instance.acquiredSequence ||
                                (other.acquiredSequence === instance.acquiredSequence &&
                                    other.id < instance.id))))
                );
            });
        };

        for (const { ref, hook } of candidates) {
            const instance = participatingEffect(facts, ref);

            if (instance === undefined || !isGroupWinner(instance, ref)) {
                continue;
            }

            const result = withVitalityHookContext(
                () => work,
                ref,
                instance,
                request,
                resources,
                request.tick,
                dispatch,
                (context) => hook.apply(context, value),
            );
            value = result.value;

            if (result.stopDispatch === true) {
                break;
            }
        }
    });
    finalizeFinishedEffects(work, ownerUnitId, resources, request.tick, dispatch);

    return value;
}

export function dispatchDamageFormula(
    work: BattleState,
    request: DamageRequest,
    owner: UnitId | null,
    stage: FormulaStage,
    operands: DamageOperands,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
) {
    return dispatchStage(
        work,
        request,
        owner,
        stage,
        operands,
        resources,
        dispatch,
        (rules) => rules[stage],
    );
}

export function dispatchDamageAmount(
    work: BattleState,
    request: DamageRequest,
    owner: UnitId | null,
    stage: AmountStage,
    pending: PendingDamage,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
) {
    return dispatchStage(
        work,
        request,
        owner,
        stage,
        pending,
        resources,
        dispatch,
        (rules) => rules[stage],
    );
}

export function dispatchDamageReactions(
    work: BattleState,
    report: DamageReport,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
): void {
    const owners = new Set([report.request.sourceUnitId, report.request.targetUnitId]);

    for (const owner of owners) {
        dispatchStage(
            work,
            report.request,
            owner,
            "reaction",
            report,
            resources,
            dispatch,
            (rules) => {
                const reaction = rules.reaction;

                return reaction === undefined
                    ? undefined
                    : {
                          priority: reaction.priority,
                          apply: (context, value) => {
                              const outcome = reaction.apply(context, value);

                              return {
                                  value,
                                  ...(outcome?.stopDispatch === true ? { stopDispatch: true } : {}),
                              };
                          },
                      };
            },
        );
    }
}

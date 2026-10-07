import type { UnitId } from "../../../unit.js";
import type { EffectAddress, EffectInstanceValue } from "../../effects/instance.js";
import { EffectDispatchScope, participatingEffect } from "../../effects/dispatch.js";
import { finalizeFinishedEffects } from "../../effects/lifecycle.js";
import type { CombatWork } from "../../../../battle/execution/work.js";
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
    work: CombatWork,
    request: DamageRequest,
    ownerUnitId: UnitId | null,
    stage: DamageHookStage,
    value: V,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
    select: (rules: CompiledDamageRules) => CompiledStage<V> | undefined,
): { readonly work: CombatWork; readonly value: V } {
    if (ownerUnitId === null) {
        return { work, value };
    }

    const facts = vitalityHookFacts(() => work, resources.vitality);
    dispatch.withCandidates(facts, ownerUnitId, (identities) => {
        const candidates = identities
            .flatMap((address) => {
                const instance = facts.getEffect(address);
                const hook =
                    instance === undefined ? undefined : select(resources.damage.get(instance));

                return instance === undefined || hook === undefined
                    ? []
                    : [{ address, sequence: instance.acquiredSequence, hook }];
            })
            .sort(
                (left, right) =>
                    right.hook.priority - left.hook.priority ||
                    left.sequence - right.sequence ||
                    left.address.instanceId - right.address.instanceId,
            );

        const isGroupWinner = (instance: EffectInstanceValue, address: EffectAddress): boolean => {
            const group = resources.damage.get(instance).group;

            if (group === undefined) {
                return true;
            }

            return !identities.some((otherAddress) => {
                const other = participatingEffect(facts, otherAddress);

                if (other === undefined || other.id === address.instanceId) {
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

        for (const { address, hook } of candidates) {
            const instance = participatingEffect(facts, address);

            if (instance === undefined || !isGroupWinner(instance, address)) {
                continue;
            }

            const result = withVitalityHookContext(
                () => work,
                (next) => {
                    work = next;
                },
                address,
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
    work = finalizeFinishedEffects(work, ownerUnitId, resources, request.tick, dispatch);

    return { work, value };
}

export function dispatchDamageFormula(
    work: CombatWork,
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
    work: CombatWork,
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
    work: CombatWork,
    report: DamageReport,
    resources: DamageResourceServices,
    dispatch: EffectDispatchScope,
): CombatWork {
    const owners = new Set([report.request.sourceUnitId, report.request.targetUnitId]);

    for (const owner of owners) {
        const result = dispatchStage(
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
        work = result.work;
    }

    return work;
}

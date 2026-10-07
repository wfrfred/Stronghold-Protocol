import type { DamageOperands, PendingDamage } from "./contract.js";
import type { DamageRule, DamageRuleContext } from "./resources.js";

export type DamageValueProvider<S extends object> = (context: DamageRuleContext<S>) => number;

export function multiplyAttackScale<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, DamageOperands> {
    return (context, operands) => ({
        work: context.work,
        value: { ...operands, attackScale: operands.attackScale * value(context) },
    });
}

export function replaceAttackScale<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, DamageOperands> {
    return (context, operands) => ({
        work: context.work,
        value: { ...operands, attackScale: value(context) },
    });
}

export function addAttackPower<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, DamageOperands> {
    return (context, operands) => ({
        work: context.work,
        value: { ...operands, attackAddition: operands.attackAddition + value(context) },
    });
}

export function multiplyDamage<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, PendingDamage> {
    return (context, pending) => ({
        work: context.work,
        value: { ...pending, amount: Math.max(0, pending.amount * value(context)) },
    });
}

export function reduceDamage<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, PendingDamage> {
    return (context, pending) => ({
        work: context.work,
        value: { ...pending, amount: Math.max(0, pending.amount - value(context)) },
    });
}

export function absorbBarrier<S extends { readonly remainingAmount: number }>(): DamageRule<
    S,
    PendingDamage
> {
    return (context, pending) => {
        const { instance, ownerUnitId, resources } = context;
        const absorbed = Math.min(pending.amount, instance.state.remainingAmount);

        if (absorbed <= 0) {
            return { work: context.work, value: pending };
        }

        const work = resources.updateEffectState(
            context.work,
            ownerUnitId,
            instance.id,
            instance.programRef,
            (current) => ({ ...current, remainingAmount: current.remainingAmount - absorbed }),
        );

        return {
            work,
            value: {
                ...pending,
                amount: pending.amount - absorbed,
                consumptions: [
                    ...pending.consumptions,
                    { ownerUnitId, instanceId: instance.id, resource: "barrier", amount: absorbed },
                ],
            },
        };
    };
}

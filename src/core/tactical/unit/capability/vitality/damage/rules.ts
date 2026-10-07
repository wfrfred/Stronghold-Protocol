import type { PendingDamage } from "./contract.js";
import type { DamageFormulaRule, DamageQueryContext, DamageRule } from "./resources.js";
import type { DispatchResult } from "../hook.js";

export type DamageValueProvider<S extends object> = (context: DamageQueryContext<S>) => number;

function queryContext<S extends object>(context: DamageQueryContext<S>): DamageQueryContext<S> {
    return {
        address: context.address,
        ownerUnitId: context.ownerUnitId,
        get instance() {
            return context.instance;
        },
        request: context.request,
        tick: context.tick,
        facts: context.facts,
    };
}

export function composeDamageRules<C, V>(
    ...rules: readonly ((context: C, value: V) => DispatchResult<V>)[]
): (context: C, value: V) => DispatchResult<V> {
    return (context, value) => {
        let stopDispatch = false;

        for (const rule of rules) {
            const result = rule(context, value);
            value = result.value;
            stopDispatch ||= result.stopDispatch === true;
        }

        return { value, ...(stopDispatch ? { stopDispatch: true } : {}) };
    };
}

export function multiplyAttackScale<S extends object>(
    value: DamageValueProvider<S>,
): DamageFormulaRule<S> {
    return (context, operands) => ({
        value: { ...operands, attackScale: operands.attackScale * value(queryContext(context)) },
    });
}

export function replaceAttackScale<S extends object>(
    value: DamageValueProvider<S>,
): DamageFormulaRule<S> {
    return (context, operands) => ({
        value: { ...operands, attackScale: value(queryContext(context)) },
    });
}

export function addAttackPower<S extends object>(
    value: DamageValueProvider<S>,
): DamageFormulaRule<S> {
    return (context, operands) => ({
        value: {
            ...operands,
            attackAddition: operands.attackAddition + value(queryContext(context)),
        },
    });
}

export function multiplyDamage<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, PendingDamage> {
    return (context, pending) => ({
        value: { ...pending, amount: Math.max(0, pending.amount * value(queryContext(context))) },
    });
}

export function reduceDamage<S extends object>(
    value: DamageValueProvider<S>,
): DamageRule<S, PendingDamage> {
    return (context, pending) => ({
        value: { ...pending, amount: Math.max(0, pending.amount - value(queryContext(context))) },
    });
}

export function absorbBarrier<S extends { readonly remainingAmount: number }>(): DamageRule<
    S,
    PendingDamage
> {
    return (context, pending) => {
        const { instance, ownerUnitId } = context;
        const absorbed = Math.min(pending.amount, instance.state.remainingAmount);

        if (pending.cancellation !== null || absorbed <= 0) {
            return { value: pending };
        }

        context.operations.effects.update(context.address, instance.programRef, (current) => ({
            ...current,
            remainingAmount: current.remainingAmount - absorbed,
        }));

        return {
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

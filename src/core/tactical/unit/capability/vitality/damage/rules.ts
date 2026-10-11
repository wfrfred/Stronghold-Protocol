import type { DamageOperands, PendingDamage } from "./contract.js";
import type { Context } from "./hook.js";
import type { Result } from "../hook.js";

export type Value<C = Context> = (context: C) => number;

export type Formula<C = Context> = (context: C, operands: DamageOperands) => Result<DamageOperands>;

export type Rule<C = Context> = (context: C, pending: PendingDamage) => Result<PendingDamage>;

export function compose<C, V>(
    ...rules: readonly ((context: C, value: V) => Result<V>)[]
): (context: C, value: V) => Result<V> {
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

export function multiplyAttackScale<C = Context>(value: Value<C>): Formula<C> {
    return (context, operands) => ({
        value: { ...operands, attackScale: operands.attackScale * value(context) },
    });
}

export function replaceAttackScale<C = Context>(value: Value<C>): Formula<C> {
    return (context, operands) => ({
        value: { ...operands, attackScale: value(context) },
    });
}

export function addAttackPower<C = Context>(value: Value<C>): Formula<C> {
    return (context, operands) => ({
        value: {
            ...operands,
            attackAddition: operands.attackAddition + value(context),
        },
    });
}

export function multiplyDamage<C = Context>(value: Value<C>): Rule<C> {
    return (context, pending) => ({
        value: { ...pending, amount: Math.max(0, pending.amount * value(context)) },
    });
}

export function reduceDamage<C = Context>(value: Value<C>): Rule<C> {
    return (context, pending) => ({
        value: { ...pending, amount: Math.max(0, pending.amount - value(context)) },
    });
}

import type { DamageOperands, PendingDamage } from "./contract.js";
import type { Context } from "./hook.js";
import type { Control } from "../hook.js";

export type Value<C = Context> = (context: C) => number;

export type Formula<C = Context> = (
    context: C,
    operands: DamageOperands,
) => DamageOperands & Control;

export type Rule<C = Context> = (context: C, pending: PendingDamage) => PendingDamage & Control;

export function compose<C, V extends Control>(
    ...rules: readonly ((context: C, value: V) => V & Control)[]
): (context: C, value: V) => V & Control {
    return (context, value) => {
        let stopDispatch = value.stopDispatch === true;

        for (const rule of rules) {
            value = rule(context, value);
            stopDispatch ||= value.stopDispatch === true;
        }

        return stopDispatch ? { ...value, stopDispatch } : value;
    };
}

export function multiplyAttackScale<C = Context>(value: Value<C>): Formula<C> {
    return (context, operands) => ({
        ...operands,
        attackScale: operands.attackScale * value(context),
    });
}

export function replaceAttackScale<C = Context>(value: Value<C>): Formula<C> {
    return (context, operands) => ({ ...operands, attackScale: value(context) });
}

export function addAttackPower<C = Context>(value: Value<C>): Formula<C> {
    return (context, operands) => ({
        ...operands,
        attackAddition: operands.attackAddition + value(context),
    });
}

export function multiplyDamage<C = Context>(value: Value<C>): Rule<C> {
    return (context, pending) => ({
        ...pending,
        amount: Math.max(0, pending.amount * value(context)),
    });
}

export function reduceDamage<C = Context>(value: Value<C>): Rule<C> {
    return (context, pending) => ({
        ...pending,
        amount: Math.max(0, pending.amount - value(context)),
    });
}

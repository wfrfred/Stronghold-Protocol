import type { Context as ReceptionContext } from "./reception.js";

export interface Context extends ReceptionContext {
    readonly hpDamage: number;
    readonly candidateHp: number;
}

export interface Rule {
    readonly id: string;
    readonly protects: (context: Context) => boolean;
}

export function isFatalDamageProtected(context: Context): boolean {
    return (
        context.candidateHp === 0 &&
        context.target.vitality.fatalProtectionRules.some((rule) => rule.protects(context))
    );
}

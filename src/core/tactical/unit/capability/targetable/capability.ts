import * as registry from "../../hook/hook.js";
import type { Unit } from "../../unit.js";
import type { TargetingDefinition } from "../../targeting/definition.js";
import type { CombatTargetQueryContext, QueryPurpose } from "../../targeting/query.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export type Definition = Readonly<Record<string, never>>;

export interface Context extends CombatTargetQueryContext {
    readonly target: Unit;
    readonly selector: TargetingDefinition;
    readonly purposes: readonly QueryPurpose[];
}

export interface Rule {
    readonly id: string;
    readonly allows: (context: Context) => boolean;
}

export interface State {
    readonly rules: readonly Rule[];
}

export interface Targetable {
    readonly definition: { readonly targetable: Definition };
    readonly targetable: State;
}

export function hasTargetable<U extends Unit>(unit: U): unit is U & Targetable {
    return "targetable" in unit && "targetable" in unit.definition;
}

export const initialize: (battle: BattleState, definition: Definition) => Result<State> = (
    battle,
) => {
    return { state: battle, value: { rules: [] } };
};

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { rules };
}

export function allowsTarget(context: Context): boolean {
    return (
        !hasTargetable(context.target) ||
        context.target.targetable.rules.every((rule) => rule.allows(context))
    );
}

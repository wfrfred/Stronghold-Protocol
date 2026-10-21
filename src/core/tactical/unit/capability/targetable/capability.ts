import * as contribution from "../../contribution/contribution.js";
import type { Contribution } from "../../contribution/contribution.js";
import type { Unit } from "../../unit.js";
import type { Request } from "../../../battle/targeting/contract.js";
import type { State as BattleState, Result } from "../../../battle/state.js";

export interface Definition {
    readonly restrictions: readonly Contribution<Restriction>[];
}

export interface Restriction {
    readonly kind: symbol;
    readonly allows: (battle: BattleState, request: Request, owner: Unit & Targetable) => boolean;
}

export interface State {
    readonly restrictions: readonly Contribution<Restriction>[];
}

export interface Targetable {
    readonly definition: { readonly targetable: Definition };
    readonly targetable: State;
}

export function hasTargetable<U extends Unit>(unit: U): unit is U & Targetable {
    return "targetable" in unit && "targetable" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    const ids = new Set<string>();

    for (const entry of definition.restrictions) {
        if (ids.has(entry.id)) {
            throw new TypeError(`duplicate targetable restriction identity: ${entry.id}`);
        }

        ids.add(entry.id);
    }

    return { state: battle, value: { restrictions: [...definition.restrictions] } };
}

export function setRestriction(state: State, entry: Contribution<Restriction>): State {
    const restrictions = contribution.set(state.restrictions, entry);

    return restrictions === state.restrictions ? state : { restrictions };
}

export function removeRestriction(state: State, id: string): State {
    const restrictions = contribution.remove(state.restrictions, id);

    return restrictions === state.restrictions ? state : { restrictions };
}

export function allowsRestrictions(
    battle: BattleState,
    request: Request,
    owner: Unit & Targetable,
    ignore?: (kind: symbol) => boolean,
): boolean {
    return contribution
        .resolve(owner.targetable.restrictions)
        .every(
            (restriction) =>
                (ignore?.(restriction.kind) ?? false) || restriction.allows(battle, request, owner),
        );
}

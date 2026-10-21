import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../../unit/unit.js";
import type { Targetable } from "../../unit/capability/targetable/capability.js";
import type { State as BattleState, Result } from "../state.js";

export type Purpose = "DAMAGE" | "HEAL" | "ELEMENT_DAMAGE" | "ELEMENT_HEAL" | "EFFECT";

export interface Request {
    readonly source: Ref<Unit>;
    readonly purposes: readonly Purpose[];
    readonly filter: Filter;
    readonly selector: Selector;
}

export type Filter = (battle: BattleState, request: Request, target: Unit & Targetable) => boolean;

export type Comparator = (
    battle: BattleState,
    request: Request,
    left: Unit & Targetable,
    right: Unit & Targetable,
) => number;

export type Selector = (
    battle: BattleState,
    request: Request,
    candidates: readonly (Unit & Targetable)[],
) => Result<readonly Ref<Unit & Targetable>[]>;

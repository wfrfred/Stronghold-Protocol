import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import type { Elemental } from "./capability.js";
import type { DamageRequest, HealRequest } from "./operations.js";

export interface Rule {
    readonly id: string;
    readonly allowsDamage?: (
        battle: BattleState,
        self: Unit & Elemental,
        request: DamageRequest,
    ) => boolean;
    readonly allowsHeal?: (
        battle: BattleState,
        self: Unit & Elemental,
        request: HealRequest,
    ) => boolean;
}

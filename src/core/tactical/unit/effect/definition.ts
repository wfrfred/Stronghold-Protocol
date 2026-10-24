import type { State as BattleState } from "../../battle/state.js";
import type { Effect } from "./effect.js";

export interface Group {
    readonly id: string;
    readonly priority: number;
}

export interface Definition<S extends object, H extends object = object> {
    readonly id: string;
    readonly group?: Group;
    readonly initialize: () => S;
    readonly onInstall?: (battle: BattleState, self: Effect<S, H>) => BattleState;
    readonly onEnable?: (battle: BattleState, self: Effect<S, H>) => BattleState;
    readonly onDisable?: (battle: BattleState, self: Effect<S, H>) => BattleState;
    readonly onTick?: (battle: BattleState, self: Effect<S, H>) => BattleState;
    readonly onEnd?: (battle: BattleState, self: Effect<S, H>, reason: string) => BattleState;
}

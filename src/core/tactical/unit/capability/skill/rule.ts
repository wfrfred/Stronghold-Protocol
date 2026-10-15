import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import type { Skill } from "./capability.js";
import type { Source } from "./sp.js";

export type Operation = "STOP" | "RETRIGGER";

export interface Rule<S extends object, A extends object> {
    readonly id: string;
    readonly allowsActivation?: (battle: BattleState, self: Unit & Skill<S, A>) => boolean;
    readonly allowsOperation?: (
        battle: BattleState,
        self: Unit & Skill<S, A>,
        operation: Operation,
    ) => boolean;
    readonly allowsRecovery?: (
        battle: BattleState,
        self: Unit & Skill<S, A>,
        source: Source,
    ) => boolean;
}

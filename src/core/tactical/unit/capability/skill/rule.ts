import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import type { Skill } from "./capability.js";
import type { Source } from "./sp.js";

export type Operation = "STOP" | "RETRIGGER";

export interface Rule {
    readonly id: string;
    readonly allowsActivation?: (battle: BattleState, self: Unit & Skill) => boolean;
    readonly allowsOperation?: (
        battle: BattleState,
        self: Unit & Skill,
        operation: Operation,
    ) => boolean;
    readonly allowsRecovery?: (battle: BattleState, self: Unit & Skill, source: Source) => boolean;
}

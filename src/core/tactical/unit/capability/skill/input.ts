import type { State as BattleState } from "../../../battle/state.js";
import type { Value } from "../../contribution/value.js";
import type { Unit } from "../../unit.js";
import type { Skill } from "./capability.js";

export type Input =
    readonly Value[] | ((battle: BattleState, self: Unit & Skill) => readonly Value[]);

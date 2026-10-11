import type { BattlefieldView } from "../battlefield/contract.js";
import type { Unit } from "./unit.js";

export interface QueryContext {
    readonly unit: Unit;
    readonly battlefield: BattlefieldView;
}

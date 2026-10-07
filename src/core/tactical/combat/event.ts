import type { UnitId } from "../unit/unit.js";
import type { DamageType } from "./effect.js";

export type CombatEvent =
    | {
          readonly type: "ACTION";
          readonly sourceUnitId: UnitId;
          readonly targetUnitId: UnitId;
          readonly tick: number;
      }
    | {
          readonly type: "DAMAGE";
          readonly sourceUnitId: UnitId | null;
          readonly targetUnitId: UnitId;
          readonly damageType: DamageType;
          readonly amount: number;
          readonly hp: number;
          readonly tick: number;
      }
    | {
          readonly type: "HEAL";
          readonly sourceUnitId: UnitId | null;
          readonly targetUnitId: UnitId;
          readonly amount: number;
          readonly hp: number;
          readonly tick: number;
      };

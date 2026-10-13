import type { Id } from "../../unit/unit.js";
import type { DamageType } from "../../unit/capability/vitality/damage/contract.js";

export type CombatEvent =
    | {
          readonly type: "ACTION";
          readonly sourceUnitId: Id;
          readonly targetUnitId: Id;
          readonly tick: number;
      }
    | {
          readonly type: "DAMAGE";
          readonly sourceUnitId: Id | null;
          readonly targetUnitId: Id;
          readonly damageType: DamageType;
          readonly amount: number;
          readonly hp: number;
          readonly tick: number;
      }
    | {
          readonly type: "HEAL";
          readonly sourceUnitId: Id | null;
          readonly targetUnitId: Id;
          readonly amount: number;
          readonly hp: number;
          readonly tick: number;
      };

import type { Id } from "../../unit/unit.js";
import type { DamageType, DamageCancellation } from "../damage/contract.js";
import type { HealingCancellation } from "../healing/contract.js";

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
          readonly receivedAmount: number;
          readonly cancellation: DamageCancellation | null;
          readonly hp: number | null;
          readonly tick: number;
      }
    | {
          readonly type: "HEAL";
          readonly sourceUnitId: Id | null;
          readonly targetUnitId: Id;
          readonly amount: number;
          readonly receivedAmount: number;
          readonly cancellation: HealingCancellation | null;
          readonly hp: number | null;
          readonly tick: number;
      };

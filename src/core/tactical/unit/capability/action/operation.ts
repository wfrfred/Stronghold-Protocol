import { assertNonnegativeNumber } from "../../../../common/assert.js";
import type { ElementType } from "../elemental/capability.js";
import type { QueryPurpose } from "../../targeting/query.js";
import { resolveAttackPower } from "../offense/query.js";
import { createDamageOperands, type DamageType } from "../vitality/damage/contract.js";
import { battlefieldView, type BattleState } from "../../../battle/state.js";
import type { CallContext } from "../../../battle/execution/call.js";
import type { Id } from "../../unit.js";
import type { ActionResources } from "./resources.js";

export type Definition =
    | {
          readonly type: "DAMAGE";
          readonly power: number;
          readonly damageType: DamageType;
          readonly powerSource?: "SOURCE_ATTACK";
      }
    | {
          readonly type: "HEAL";
          readonly power: number;
          readonly ignoreHealFree: boolean;
      }
    | { readonly type: "ELEMENT_DAMAGE"; readonly elementType: ElementType; readonly power: number }
    | { readonly type: "ELEMENT_HEAL"; readonly power: number };

export function create(definition: Definition): Definition {
    assertNonnegativeNumber(definition.power, "operation power");

    return Object.freeze({ ...definition });
}

export function purposes(definition: Definition): readonly QueryPurpose[] {
    switch (definition.type) {
        case "DAMAGE":
            return ["DAMAGE"];

        case "HEAL":
            return ["HEAL"];

        case "ELEMENT_DAMAGE":
            return ["ELEMENT_DAMAGE"];

        case "ELEMENT_HEAL":
            return ["ELEMENT_HEAL"];
    }
}

export interface Context {
    readonly call: CallContext;
    readonly sourceUnitId: Id;
    readonly targetUnitId: Id;
    readonly tick: number;
}

export type Program = (state: BattleState, context: Context) => BattleState;

export function compile(definition: Definition, resources: ActionResources): Program {
    switch (definition.type) {
        case "DAMAGE": {
            const readPower =
                definition.powerSource === "SOURCE_ATTACK"
                    ? (state: BattleState, { sourceUnitId }: Context): number | undefined =>
                          resolveAttackPower(sourceUnitId, battlefieldView(state))
                    : (): number => definition.power;

            return (state, context) => {
                const { sourceUnitId, targetUnitId, tick, call } = context;
                const power = readPower(state, context);

                if (power === undefined) {
                    return state;
                }

                return resources.settleDamage(
                    state,
                    {
                        sourceUnitId,
                        targetUnitId,
                        tick,
                        damageType: definition.damageType,
                        operands: createDamageOperands(power),
                    },
                    call,
                ).state;
            };
        }

        case "ELEMENT_DAMAGE":
            return (state, { sourceUnitId, targetUnitId, tick, call }) => {
                return resources.settleElementDamage(
                    state,
                    {
                        sourceUnitId,
                        targetUnitId,
                        tick,
                        type: definition.elementType,
                        power: definition.power,
                    },
                    call,
                ).state;
            };

        case "ELEMENT_HEAL":
            return (state, { sourceUnitId, targetUnitId, tick, call }) => {
                return resources.settleElementHeal(
                    state,
                    {
                        sourceUnitId,
                        targetUnitId,
                        tick,
                        power: definition.power,
                    },
                    call,
                ).state;
            };

        case "HEAL":
            return (state, { sourceUnitId, targetUnitId, tick, call }) => {
                return resources.settleHealing(
                    state,
                    {
                        sourceUnitId,
                        targetUnitId,
                        power: definition.power,
                        ignoreHealFree: definition.ignoreHealFree,
                        tick,
                    },
                    call,
                ).state;
            };
    }
}

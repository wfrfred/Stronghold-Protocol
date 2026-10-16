import { assertNonnegativeNumber } from "../../../common/assert.js";
import { battlefieldView, type Result, type State as BattleState } from "../state.js";
import * as units from "../../unit/query.js";
import { resolveDefense } from "../../unit/capability/defense/query.js";
import { hasElemental } from "../../unit/capability/elemental/capability.js";
import { resolveDamageResistance } from "../../unit/capability/elemental/query.js";
import type { CalculatedDamage, DamageParameters, DamageRequest } from "./contract.js";
import { dispatch } from "./hook.js";

export function calculateDamage(
    battle: BattleState,
    request: DamageRequest,
): Result<CalculatedDamage | undefined> {
    const unavailable = (current: BattleState) => {
        const target = units.get(current, request.target);

        return target?.lifecycle !== "PRESENT" || target.vitality.hp <= 0;
    };

    if (unavailable(battle)) {
        return { state: battle, value: undefined };
    }

    let parameters = request.parameters;

    for (const [owner, stage] of [
        [request.source, "sourceFormula"],
        [request.target, "targetFormula"],
    ] as const) {
        const result = dispatch(
            battle,
            owner,
            request,
            parameters,
            (entry) =>
                (entry.stage === "sourceFormula" || entry.stage === "targetFormula") &&
                entry.stage === stage
                    ? entry
                    : undefined,
            unavailable,
        );
        battle = result.state;
        parameters = result.value;
    }

    if (unavailable(battle)) {
        return { state: battle, value: undefined };
    }

    const amount = formula(battle, request, parameters);
    assertNonnegativeNumber(amount, "calculated damage");
    const output = dispatch(
        battle,
        request.source,
        { request, type: parameters.type },
        amount,
        (entry) => (entry.stage === "output" ? entry : undefined),
        unavailable,
    );
    assertNonnegativeNumber(output.value, "output damage");

    return {
        state: output.state,
        value: unavailable(output.state)
            ? undefined
            : { type: parameters.type, amount: output.value },
    };
}

function formula(
    battle: BattleState,
    request: DamageRequest,
    parameters: DamageParameters,
): number {
    const attack = parameters.attack;
    const power = Math.max(0, attack.power * attack.multiplier + attack.addition);

    switch (parameters.type) {
        case "PHYSICAL": {
            const defense = resolveDefense(request.target.id, battlefieldView(battle))!.defense;
            const effective =
                Math.max(0, defense - parameters.penetration.fixed) *
                Math.max(0, 1 - parameters.penetration.proportional);

            return Math.max(power * 0.05, power - effective);
        }

        case "ARTS": {
            const resistance = resolveDefense(
                request.target.id,
                battlefieldView(battle),
            )!.resistance;
            const effective =
                Math.max(0, resistance - parameters.penetration.fixed) *
                Math.max(0, 1 - parameters.penetration.proportional);

            return Math.max(power * 0.05, power * (1 - effective / 100));
        }

        case "TRUE":
            return power;

        case "ELEMENTAL": {
            const target = units.get(battle, request.target)!;
            const resistance = hasElemental(target)
                ? (resolveDamageResistance(battle, units.ref(target)) ?? 0)
                : 0;

            return Math.max(power * 0.05, power * Math.max(0, 1 - resistance / 100));
        }
    }
}

import { assertNonnegativeNumber } from "../../../common/assert.js";
import type { Result, State as BattleState } from "../state.js";
import * as units from "../../unit/query.js";
import type { CalculatedHealing, HealingRequest } from "./contract.js";
import { dispatch } from "./hook.js";

export function calculateHealing(
    battle: BattleState,
    request: HealingRequest,
): Result<CalculatedHealing | undefined> {
    const unavailable = (current: BattleState) => {
        const target = units.get(current, request.target);

        return target?.lifecycle !== "PRESENT" || target.vitality.hp <= 0;
    };

    if (unavailable(battle)) {
        return { state: battle, value: undefined };
    }

    let parameters = { ...request.parameters, power: Math.max(0, request.parameters.power) };

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

    const amount = Math.max(0, parameters.power * parameters.multiplier);
    assertNonnegativeNumber(amount, "calculated healing");
    const output = dispatch(
        battle,
        request.source,
        { request },
        amount,
        (entry) => (entry.stage === "output" ? entry : undefined),
        unavailable,
    );
    assertNonnegativeNumber(output.value, "output healing");

    return {
        state: output.state,
        value: unavailable(output.state) ? undefined : { amount: output.value },
    };
}

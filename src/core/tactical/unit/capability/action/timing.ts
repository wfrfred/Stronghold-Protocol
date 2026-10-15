import { assertFiniteNumber } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import { battlefieldView, type State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import type { Definition } from "../../action/definition.js";
import type { Action } from "./capability.js";

type StoredDefinition = Pick<Definition, "intervalTicks" | "speed">;

export function resolveSpeed(
    battle: BattleState,
    source: Ref<Unit & Action>,
    definition: StoredDefinition,
): number | undefined {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return undefined;
    }

    const context = { unit, battlefield: battlefieldView(battle) };

    return Math.max(
        20,
        modifier.apply(
            definition.speed,
            contribution.resolve(unit.action.speed, (value) =>
                contribution.evaluate(value, context),
            ),
        ),
    );
}

export function resolveBaseInterval(
    battle: BattleState,
    source: Ref<Unit & Action>,
    definition: StoredDefinition,
): number | undefined {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return undefined;
    }

    const context = { unit, battlefield: battlefieldView(battle) };

    return Math.max(
        0,
        modifier.apply(
            definition.intervalTicks,
            contribution.resolve(unit.action.interval, (value) =>
                contribution.evaluate(value, context),
            ),
        ),
    );
}

export function resolveInterval(
    battle: BattleState,
    source: Ref<Unit & Action>,
    definition: StoredDefinition,
): number | undefined {
    const interval = resolveBaseInterval(battle, source, definition);
    const speed = resolveSpeed(battle, source, definition);

    if (interval === undefined || speed === undefined) {
        return undefined;
    }

    const periodTicks = interval * (100 / Math.min(600, speed));
    assertFiniteNumber(periodTicks, "effective action interval");

    return Math.max(1, periodTicks);
}

import { assertFiniteNumber } from "../../../../common/assert.js";
import type { Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import * as contribution from "../../contribution/contribution.js";
import * as attribute from "../../contribution/attribute.js";
import type { View } from "../../action/definition.js";
import type { Action } from "./capability.js";

type Timing = Pick<View, "intervalTicks" | "speed">;

export function resolveSpeed(
    battle: BattleState,
    source: Ref<Unit & Action>,
    definition: Timing,
): number | undefined {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return undefined;
    }

    return Math.max(
        20,
        attribute.apply(
            definition.speed,
            contribution
                .resolve(unit.action.speed)
                .flatMap((input) => (typeof input === "function" ? input(battle, unit) : input)),
        ),
    );
}

export function resolveBaseInterval(
    battle: BattleState,
    source: Ref<Unit & Action>,
    definition: Timing,
): number | undefined {
    const unit = units.get(battle, source);

    if (unit === undefined) {
        return undefined;
    }

    return Math.max(
        0,
        attribute.apply(
            definition.intervalTicks,
            contribution
                .resolve(unit.action.interval)
                .flatMap((input) => (typeof input === "function" ? input(battle, unit) : input)),
        ),
    );
}

export function resolveInterval(
    battle: BattleState,
    source: Ref<Unit & Action>,
    definition: Timing,
): number | undefined {
    const interval = resolveBaseInterval(battle, source, definition);
    const speed = resolveSpeed(battle, source, definition);

    if (interval === undefined || speed === undefined) {
        return undefined;
    }

    return period(interval, speed);
}

export function period(intervalTicks: number, speed: number): number {
    const periodTicks = intervalTicks * (100 / Math.min(600, Math.max(20, speed)));
    assertFiniteNumber(periodTicks, "effective action interval");

    return Math.max(1, periodTicks);
}

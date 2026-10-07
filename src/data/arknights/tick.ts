import { assertFiniteNumber } from "../../core/common/assert.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";

export function secondsToTicks(value: number, name = "time"): number {
    assertFiniteNumber(value, name);

    const ticks = value * TICKS_PER_SECOND;
    const nearest = Math.round(ticks);
    const nearInteger =
        nearest !== 0 &&
        Math.abs(ticks - nearest) <= Number.EPSILON * Math.max(1, Math.abs(ticks)) * 4;
    const result = nearInteger ? nearest : Math.ceil(ticks);

    if (!Number.isSafeInteger(result)) {
        throw new RangeError(`${name} exceeds the safe tick range`);
    }

    return result === 0 ? 0 : result;
}

export function perSecondToPerTick(value: number): number {
    assertFiniteNumber(value, "rate");

    return value / TICKS_PER_SECOND;
}

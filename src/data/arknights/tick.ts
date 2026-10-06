import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";

export function secondsToTicks(value: number, name = "time"): number {
    if (!Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }
    const ticks = value * TICKS_PER_SECOND;
    const nearest = Math.round(ticks);
    const result =
        nearest !== 0 &&
        Math.abs(ticks - nearest) <= Number.EPSILON * Math.max(1, Math.abs(ticks)) * 4
            ? nearest
            : Math.ceil(ticks);
    if (!Number.isSafeInteger(result)) {
        throw new RangeError(`${name} exceeds the safe tick range`);
    }
    return result === 0 ? 0 : result;
}

export function perSecondToPerTick(value: number): number {
    if (!Number.isFinite(value)) {
        throw new RangeError("rate must be finite");
    }
    return value / TICKS_PER_SECOND;
}

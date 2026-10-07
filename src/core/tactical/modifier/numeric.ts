export interface NumericContribution {
    readonly addition: number;
    readonly multiplier: number;
    readonly finalAddition: number;
    readonly finalScaler: number;
}

export const NEUTRAL_NUMERIC_CONTRIBUTION: NumericContribution = Object.freeze({
    addition: 0,
    multiplier: 0,
    finalAddition: 0,
    finalScaler: 1,
});

export function createNumericContribution(
    contribution: Partial<NumericContribution> = {},
): NumericContribution {
    const { addition = 0, multiplier = 0, finalAddition = 0, finalScaler = 1 } = contribution;
    const normalized = { addition, multiplier, finalAddition, finalScaler };

    for (const [name, value] of Object.entries(normalized)) {
        if (!Number.isFinite(value)) {
            throw new RangeError(`numeric contribution ${name} must be finite`);
        }
    }

    return Object.freeze(normalized);
}

export function resolveNumericValue(
    base: number,
    orderedContributions: Iterable<NumericContribution>,
): number {
    let addition = 0;
    let multiplier = 0;
    let finalAddition = 0;
    let finalScaler = 1;

    for (const contribution of orderedContributions) {
        addition += contribution.addition;
        multiplier += contribution.multiplier;
        finalAddition += contribution.finalAddition;
        finalScaler *= contribution.finalScaler;
    }

    const value = ((base + addition) * Math.max(0, 1 + multiplier) + finalAddition) * finalScaler;

    if (!Number.isFinite(value)) {
        throw new RangeError("resolved numeric value must be finite");
    }

    return value;
}

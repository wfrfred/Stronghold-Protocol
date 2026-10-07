export function finiteVitalityAmount(amount: number, description: string): number {
    if (!Number.isFinite(amount)) {
        throw new RangeError(`${description} must be finite`);
    }

    return amount;
}

export function applicableVitalityAmount(amount: number, description: string): number {
    finiteVitalityAmount(amount, description);

    if (amount < 0) {
        throw new RangeError(`${description} must be nonnegative`);
    }

    return amount;
}

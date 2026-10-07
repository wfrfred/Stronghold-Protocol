type AssertionErrorConstructor = new (message: string) => Error;

export function assert(
    condition: unknown,
    message: string,
    ErrorType: AssertionErrorConstructor = Error,
): asserts condition {
    if (!condition) {
        throw new ErrorType(message);
    }
}

export function assertFiniteNumber(
    value: unknown,
    name: string,
    ErrorType: AssertionErrorConstructor = RangeError,
): asserts value is number {
    assert(
        typeof value === "number" && Number.isFinite(value),
        `${name} must be a finite number`,
        ErrorType,
    );
}

export function assertNonnegativeNumber(
    value: unknown,
    name: string,
    ErrorType: AssertionErrorConstructor = RangeError,
): asserts value is number {
    assert(
        typeof value === "number" && Number.isFinite(value) && value >= 0,
        `${name} must be a finite nonnegative number`,
        ErrorType,
    );
}

export function assertPositiveNumber(
    value: unknown,
    name: string,
    ErrorType: AssertionErrorConstructor = RangeError,
): asserts value is number {
    assert(
        typeof value === "number" && Number.isFinite(value) && value > 0,
        `${name} must be a finite positive number`,
        ErrorType,
    );
}

export function assertSafeInteger(
    value: unknown,
    name: string,
    ErrorType: AssertionErrorConstructor = RangeError,
): asserts value is number {
    assert(
        typeof value === "number" && Number.isSafeInteger(value),
        `${name} must be a safe integer`,
        ErrorType,
    );
}

export function assertNonnegativeSafeInteger(
    value: unknown,
    name: string,
    ErrorType: AssertionErrorConstructor = RangeError,
): asserts value is number {
    assert(
        typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
        `${name} must be a nonnegative safe integer`,
        ErrorType,
    );
}

export function assertPositiveSafeInteger(
    value: unknown,
    name: string,
    ErrorType: AssertionErrorConstructor = RangeError,
): asserts value is number {
    assert(
        typeof value === "number" && Number.isSafeInteger(value) && value > 0,
        `${name} must be a positive safe integer`,
        ErrorType,
    );
}

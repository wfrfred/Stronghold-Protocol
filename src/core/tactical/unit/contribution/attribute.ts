import { assertFiniteNumber } from "../../../common/assert.js";

export interface Modifier {
    readonly addition: number;
    readonly multiplier: number;
    readonly finalAddition: number;
    readonly finalScaler: number;
}

export type Input<C> = readonly Modifier[] | ((context: C) => readonly Modifier[]);

export function create(input: Partial<Modifier> = {}): Modifier {
    const { addition = 0, multiplier = 0, finalAddition = 0, finalScaler = 1 } = input;
    const normalized = { addition, multiplier, finalAddition, finalScaler };

    for (const [name, value] of Object.entries(normalized)) {
        assertFiniteNumber(value, `modifier ${name}`);
    }

    return Object.freeze(normalized);
}

export function evaluate<C>(input: Input<C>, context: C): readonly Modifier[] {
    return typeof input === "function" ? input(context) : input;
}

export function apply(base: number, modifiers: Iterable<Modifier>): number {
    let addition = 0;
    let multiplier = 0;
    let finalAddition = 0;
    let finalScaler = 1;

    for (const modifier of modifiers) {
        addition += modifier.addition;
        multiplier += modifier.multiplier;
        finalAddition += modifier.finalAddition;
        finalScaler *= modifier.finalScaler;
    }

    const value = ((base + addition) * Math.max(0, 1 + multiplier) + finalAddition) * finalScaler;

    assertFiniteNumber(value, "resolved attribute value");

    return value;
}

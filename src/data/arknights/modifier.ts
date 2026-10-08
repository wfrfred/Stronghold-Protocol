import { assertFiniteNumber, assertNonnegativeSafeInteger } from "../../core/common/assert.js";
import * as modifier from "../../core/tactical/modifier/value.js";
import { TICKS_PER_SECOND } from "../../core/tactical/tick.js";

const attributes = {
    MAX_HP: 0,
    ATK: 1,
    DEF: 2,
    MAGIC_RESISTANCE: 3,
    MOVE_SPEED: 6,
    ATTACK_SPEED: 7,
    BASE_ATTACK_TIME: 8,
} as const;

const formulas = { ADDITION: 0, MULTIPLIER: 1, FINAL_ADDITION: 2, FINAL_SCALER: 3 } as const;
const fields = new Set([
    "attributeType",
    "formulaItem",
    "value",
    "loadFromBlackboard",
    "fetchBaseValueFromSourceEntity",
]);

export type ModifierAttribute = keyof typeof attributes;

export type ModifierFormula = keyof typeof formulas;

export interface AttributeModifier {
    readonly attributeType: ModifierAttribute;
    readonly formulaItem: ModifierFormula;
    readonly value: number;
    readonly loadFromBlackboard: boolean;
    readonly fetchBaseValueFromSourceEntity: boolean;
}

export interface ModifierInput {
    readonly blackboard: ReadonlyMap<string, number>;
    readonly stackCount: number;
    readonly readSourceAttribute: (attribute: ModifierAttribute) => number | undefined;
}

export interface CompiledAttributeModifier {
    readonly attributeType: ModifierAttribute;
    readonly sample: (input: ModifierInput) => modifier.Value | undefined;
}

function enumKey<T extends Record<string, number>>(
    value: unknown,
    values: T,
    name: string,
): keyof T {
    for (const key in values) {
        if (value === key || value === values[key]) {
            return key;
        }
    }

    throw new TypeError(`unsupported modifier ${name}: ${String(value)}`);
}

export function parseAttributeModifiers(value: unknown): readonly AttributeModifier[] {
    if (!Array.isArray(value)) {
        throw new TypeError("attributeModifiers must be an array");
    }

    const definitions: AttributeModifier[] = [];

    for (let index = 0; index < value.length; index++) {
        const entry: unknown = value[index];

        if (
            !Object.hasOwn(value, index) ||
            entry === null ||
            typeof entry !== "object" ||
            Array.isArray(entry)
        ) {
            throw new TypeError(`invalid attribute modifier at index ${index}`);
        }

        const source = entry as Record<string, unknown>;

        for (const key of Object.keys(source)) {
            if (!fields.has(key)) {
                throw new TypeError(`unsupported modifier field ${key}`);
            }
        }

        assertFiniteNumber(source.value, "modifier value");

        if (
            typeof source.loadFromBlackboard !== "boolean" ||
            typeof source.fetchBaseValueFromSourceEntity !== "boolean"
        ) {
            throw new TypeError("modifier loading flags must be boolean");
        }

        definitions.push(
            Object.freeze({
                attributeType: enumKey(source.attributeType, attributes, "attributeType"),
                formulaItem: enumKey(source.formulaItem, formulas, "formulaItem"),
                value: source.value,
                loadFromBlackboard: source.loadFromBlackboard,
                fetchBaseValueFromSourceEntity: source.fetchBaseValueFromSourceEntity,
            }),
        );
    }

    return Object.freeze(definitions);
}

function finalScaler(value: number): number {
    return value < 0 ? 1 + value : value;
}

function sampleValue(
    definition: AttributeModifier,
    input: ModifierInput,
): modifier.Value | undefined {
    const { attributeType, formulaItem } = definition;
    const raw = definition.loadFromBlackboard
        ? (input.blackboard.get(attributeType.toLowerCase()) ?? definition.value)
        : definition.value;
    const value = raw * input.stackCount;
    assertFiniteNumber(value, "stacked modifier value");
    const source = definition.fetchBaseValueFromSourceEntity
        ? input.readSourceAttribute(attributeType)
        : undefined;

    if (definition.fetchBaseValueFromSourceEntity && source === undefined) {
        return undefined;
    }

    switch (formulaItem) {
        case "ADDITION":
            return modifier.create({ addition: source === undefined ? value : source + value });

        case "MULTIPLIER":
            return modifier.create(
                source === undefined ? { multiplier: value } : { addition: source * value },
            );

        case "FINAL_ADDITION":
            return modifier.create({
                finalAddition: source === undefined ? value : source + value,
            });

        case "FINAL_SCALER":
            return modifier.create(
                source === undefined
                    ? { finalScaler: finalScaler(value) }
                    : { finalAddition: source * finalScaler(value) },
            );
    }
}

function normalizeValue(attribute: ModifierAttribute, value: modifier.Value): modifier.Value {
    let scale = 1;

    if (attribute === "BASE_ATTACK_TIME") {
        scale = TICKS_PER_SECOND;
    } else if (attribute === "MOVE_SPEED") {
        scale = 1 / TICKS_PER_SECOND;
    }

    return scale === 1
        ? value
        : modifier.create({
              ...value,
              addition: value.addition * scale,
              finalAddition: value.finalAddition * scale,
          });
}

export function compileAttributeModifiers(
    definitions: readonly AttributeModifier[],
): readonly CompiledAttributeModifier[] {
    return Object.freeze(
        definitions.map((input) => {
            const definition = Object.freeze({ ...input });

            return Object.freeze({
                attributeType: definition.attributeType,
                sample: (context: ModifierInput) => {
                    assertNonnegativeSafeInteger(
                        context.stackCount,
                        "effective modifier stack count",
                    );

                    if (context.stackCount === 0) {
                        return undefined;
                    }

                    const value = sampleValue(definition, context);

                    return value === undefined
                        ? undefined
                        : normalizeValue(definition.attributeType, value);
                },
            });
        }),
    );
}

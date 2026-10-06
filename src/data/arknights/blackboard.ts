export interface ArknightsBlackboardEntry {
    readonly key: string;
    readonly value: number;
    readonly valueStr: string | null;
}

export function parseBlackboard(
    value: unknown,
    name: string,
    options: { readonly allowEmptyKeys?: boolean; readonly allowMissingValueStr?: boolean } = {},
): readonly ArknightsBlackboardEntry[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array`);
    }
    const keys = new Set<string>();
    const entries: ArknightsBlackboardEntry[] = [];
    for (let index = 0; index < value.length; index++) {
        const path = `${name}[${index}]`;
        if (!Object.hasOwn(value, index) || value[index] === undefined) {
            throw new TypeError(`${name} must be dense`);
        }
        const item: unknown = value[index];
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
            throw new TypeError(`${path} must be an object`);
        }
        const source = item as Record<string, unknown>;
        for (const key of Object.keys(source)) {
            if (key !== "key" && key !== "value" && key !== "valueStr") {
                throw new TypeError(`${path} has unsupported field ${key}`);
            }
        }
        const key = source.key;
        if (typeof key !== "string") {
            throw new TypeError(`${path}.key must be a string`);
        }
        if (key.length === 0 && options.allowEmptyKeys !== true) {
            throw new TypeError(`${path}.key must not be empty`);
        }
        if (keys.has(key)) {
            throw new TypeError(`${name} has duplicate blackboard key ${key}`);
        }
        keys.add(key);
        const number = source.value;
        if (typeof number !== "number" || !Number.isFinite(number)) {
            throw new RangeError(`${path}.value must be finite`);
        }
        const valueStr =
            source.valueStr === undefined && options.allowMissingValueStr === true
                ? null
                : source.valueStr;
        if (valueStr !== null && typeof valueStr !== "string") {
            throw new TypeError(`${path}.valueStr must be a string or null`);
        }
        entries.push(Object.freeze({ key, value: number, valueStr }));
    }
    return Object.freeze(entries);
}

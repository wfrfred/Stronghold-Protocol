const ownedValues = new WeakSet();

function ownData(
    value: unknown,
    ancestors: Set<object>,
    copies: Map<object, object>,
    name: string,
): unknown {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
    ) {
        return value;
    }
    if (typeof value !== "object") {
        throw new TypeError(`${name} must contain only finite, data-only values`);
    }
    if (ownedValues.has(value)) {
        return value;
    }
    if (copies.has(value)) {
        return copies.get(value)!;
    }
    if (ancestors.has(value)) {
        throw new TypeError(`${name} cannot contain cycles`);
    }
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError(`${name} must contain plain records and arrays`);
    }

    ancestors.add(value);
    let owned: object;

    if (Array.isArray(value)) {
        const items: unknown[] = [];

        for (const key of Reflect.ownKeys(value)) {
            if (key === "length") {
                continue;
            }
            if (
                typeof key !== "string" ||
                !Number.isInteger(Number(key)) ||
                Number(key) < 0 ||
                Number(key) >= value.length ||
                String(Number(key)) !== key
            ) {
                throw new TypeError(`${name} arrays cannot contain extra properties`);
            }
        }

        for (let index = 0; index < value.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

            if (descriptor === undefined) {
                throw new TypeError(`${name} arrays must be dense`);
            }
            if (!("value" in descriptor)) {
                throw new TypeError(`${name} cannot contain accessors`);
            }

            items.push(ownData(descriptor.value, ancestors, copies, name));
        }

        owned = Object.freeze(items);
    } else {
        const record: Record<string, unknown> = {};

        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") {
                throw new TypeError(`${name} cannot contain symbol properties`);
            }

            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;

            if (!("value" in descriptor)) {
                throw new TypeError(`${name} cannot contain accessors`);
            }

            Object.defineProperty(record, key, {
                value: ownData(descriptor.value, ancestors, copies, name),
                enumerable: true,
            });
        }

        owned = Object.freeze(record);
    }

    ancestors.delete(value);
    ownedValues.add(owned);
    copies.set(value, owned);

    return owned;
}

export function ownDataRecord<S extends object>(value: S, name = "runtime state"): S {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError(`${name} root must be a plain record`);
    }

    return ownData(value, new Set(), new Map(), name) as S;
}

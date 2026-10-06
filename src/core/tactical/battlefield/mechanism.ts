export type MechanismId = number;

export interface MechanismDefinition {
    readonly id: string;
}

export interface MechanismRuntime<D extends MechanismDefinition = MechanismDefinition> {
    readonly id: MechanismId;
    readonly definition: D;
    readonly active: boolean;
}

export function createMechanismDefinition(definition: MechanismDefinition): MechanismDefinition {
    if (typeof definition.id !== "string" || definition.id.length === 0) {
        throw new TypeError("mechanism definition id must be nonempty");
    }
    return Object.freeze({ id: definition.id });
}

export function createMechanismRuntime<D extends MechanismDefinition>(
    runtime: MechanismRuntime<D>,
): MechanismRuntime<D> {
    if (!Number.isSafeInteger(runtime.id) || runtime.id < 0) {
        throw new RangeError("mechanism id must be a nonnegative safe integer");
    }
    if (typeof runtime.active !== "boolean") {
        throw new TypeError("mechanism active must be boolean");
    }
    return { id: runtime.id, definition: runtime.definition, active: runtime.active };
}

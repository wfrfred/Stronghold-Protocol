import { assertNonnegativeSafeInteger } from "../../common/assert.js";

export type MechanismId = number;

export interface MechanismView {
    readonly mechanismIds: readonly MechanismId[];
    getMechanism(id: MechanismId): MechanismRuntime | undefined;
}

export interface MechanismDefinition {
    readonly id: string;
}

export interface MechanismRuntime<D extends MechanismDefinition = MechanismDefinition> {
    readonly id: MechanismId;
    readonly definition: D;
    readonly active: boolean;
}

export function createMechanismDefinition(definition: MechanismDefinition): MechanismDefinition {
    if (definition.id.length === 0) {
        throw new TypeError("mechanism definition id must be nonempty");
    }

    return Object.freeze({ id: definition.id });
}

export function createMechanismRuntime<D extends MechanismDefinition>(
    runtime: MechanismRuntime<D>,
): MechanismRuntime<D> {
    assertNonnegativeSafeInteger(runtime.id, "mechanism id");

    return {
        id: runtime.id,
        definition: runtime.definition,
        active: runtime.active,
    };
}

import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { ElementalReceiver, ElementType } from "./capability.js";
import type { ElementalBurstDefinition } from "./definition.js";

export class ElementalResources {
    readonly #registration: ResourceRegistration;
    readonly #definitions = new Map<
        ElementalReceiver,
        Map<ElementType, ElementalBurstDefinition>
    >();

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register(
        receiver: ElementalReceiver,
        type: ElementType,
        definition: ElementalBurstDefinition,
    ): void {
        this.#registration.assertWritable();
        let definitions = this.#definitions.get(receiver);

        if (definitions === undefined) {
            definitions = new Map();
            this.#definitions.set(receiver, definitions);
        }
        if (definitions.has(type)) {
            throw new TypeError(`duplicate elemental burst ${receiver}/${type}`);
        }

        definitions.set(type, Object.freeze({ ...definition }));
    }

    get(receiver: ElementalReceiver, type: ElementType): ElementalBurstDefinition {
        this.#registration.assertUsable();
        const definition = this.#definitions.get(receiver)?.get(type);

        if (definition === undefined) {
            throw new TypeError(`unregistered elemental burst ${receiver}/${type}`);
        }

        return definition;
    }
}

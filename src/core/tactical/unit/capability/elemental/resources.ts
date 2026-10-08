import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { ElementalReceiver, ElementType } from "./capability.js";
import type { CompiledElementalBurst } from "./program.js";

export class ElementalResources {
    readonly #registration: ResourceRegistration;
    readonly #programs = new Map<ElementalReceiver, Map<ElementType, CompiledElementalBurst>>();

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register(
        receiver: ElementalReceiver,
        type: ElementType,
        program: CompiledElementalBurst,
    ): void {
        this.#registration.assertWritable();
        let programs = this.#programs.get(receiver);

        if (programs === undefined) {
            programs = new Map();
            this.#programs.set(receiver, programs);
        }
        if (programs.has(type)) {
            throw new TypeError(`duplicate elemental burst ${receiver}/${type}`);
        }

        programs.set(type, Object.freeze({ ...program }));
    }

    get(receiver: ElementalReceiver, type: ElementType): CompiledElementalBurst {
        this.#registration.assertUsable();
        const program = this.#programs.get(receiver)?.get(type);

        if (program === undefined) {
            throw new TypeError(`unregistered elemental burst ${receiver}/${type}`);
        }

        return program;
    }
}

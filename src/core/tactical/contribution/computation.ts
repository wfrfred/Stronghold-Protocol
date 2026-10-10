import { ResourceRegistration } from "../../common/resource-registration.js";
import type * as contribution from "./state.js";
import type * as modifier from "./value.js";

export type Compute<C> = (context: C, entry: contribution.Live) => readonly modifier.Value[];

export interface Computations<C> {
    bind(context: C): contribution.Evaluate;
}

export class Resources<C> implements Computations<C> {
    readonly #computations = new Map<string, Compute<C>>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register(ref: string, compute: Compute<C>): void {
        this.#registration.assertWritable();

        if (this.#computations.has(ref)) {
            throw new TypeError(`duplicate computation ${ref}`);
        }

        this.#computations.set(ref, compute);
    }

    bind(context: C): contribution.Evaluate {
        this.#registration.assertUsable();

        return (entry) => {
            this.#registration.assertUsable();
            const compute = this.#computations.get(entry.evaluator);

            if (compute === undefined) {
                throw new TypeError(`unregistered computation ${entry.evaluator}`);
            }

            return compute(context, entry);
        };
    }
}

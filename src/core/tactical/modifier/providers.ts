import { ResourceRegistration } from "../../common/resource-registration.js";
import type { NumericContributionEvaluator, NumericProviderContribution } from "./contribution.js";
import type { NumericContribution } from "./numeric.js";

export type CompiledNumericProvider<C> = (
    context: C,
    entry: NumericProviderContribution,
) => readonly NumericContribution[];

export interface NumericContributionProvider<C> {
    evaluator(context: C): NumericContributionEvaluator;
}

export class NumericContributionResources<C> implements NumericContributionProvider<C> {
    readonly #providers = new Map<string, CompiledNumericProvider<C>>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register(ref: string, provider: CompiledNumericProvider<C>): void {
        this.#registration.assertWritable();

        if (this.#providers.has(ref)) {
            throw new TypeError(`duplicate numeric provider ${ref}`);
        }

        this.#providers.set(ref, provider);
    }

    evaluator(context: C): NumericContributionEvaluator {
        this.#registration.assertUsable();

        return (entry) => {
            this.#registration.assertUsable();
            const provider = this.#providers.get(entry.providerRef);

            if (provider === undefined) {
                throw new TypeError(`unregistered numeric provider ${entry.providerRef}`);
            }

            return provider(context, entry);
        };
    }
}

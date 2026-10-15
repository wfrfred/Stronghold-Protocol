import { ResourceRegistration } from "../../common/resource-registration.js";
import { ElementalResources } from "../unit/capability/elemental/resources.js";

export class CombatResources {
    readonly #registration = new ResourceRegistration();
    readonly elemental = new ElementalResources(this.#registration);
    seal(): this {
        this.#registration.seal();

        return this;
    }
}

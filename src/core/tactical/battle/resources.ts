import { ResourceRegistration } from "../../common/resource-registration.js";
import { ElementalResources } from "../unit/capability/elemental/resources.js";
import { SkillResources } from "../unit/capability/skill/resources.js";

export class CombatResources {
    readonly #registration = new ResourceRegistration();
    readonly skills = new SkillResources(this.#registration);
    readonly elemental = new ElementalResources(this.#registration);
    seal(): this {
        this.#registration.seal();

        return this;
    }
}

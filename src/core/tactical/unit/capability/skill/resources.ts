import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { SkillDefinition } from "./capability.js";
import type { CompiledSkill } from "./compiled.js";

export class SkillResources {
    readonly #compiledSkills = new Map<SkillDefinition, CompiledSkill>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register(compiled: CompiledSkill): CompiledSkill {
        this.#registration.assertWritable();

        const { definition } = compiled;

        if (this.#compiledSkills.has(definition)) {
            throw new TypeError(`duplicate compiled skill ${compiled.definition.id}`);
        }

        this.#compiledSkills.set(definition, compiled);

        return compiled;
    }

    get(definition: SkillDefinition): CompiledSkill {
        this.#registration.assertUsable();
        const compiled = this.#compiledSkills.get(definition);

        if (compiled === undefined) {
            throw new TypeError(`unregistered skill ${definition.id}`);
        }

        return compiled;
    }
}

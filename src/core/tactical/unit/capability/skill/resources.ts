import { ResourceRegistration } from "../../../../common/resource-registration.js";
import type { SkillDefinition } from "./capability.js";
import type { CompiledSkill } from "./program.js";

export class SkillResources {
    readonly #programs = new Map<SkillDefinition, CompiledSkill>();
    readonly #registration: ResourceRegistration;

    constructor(registration = new ResourceRegistration()) {
        this.#registration = registration;
    }

    register(compiled: CompiledSkill): CompiledSkill {
        this.#registration.assertWritable();

        const { definition } = compiled;

        if (this.#programs.has(definition)) {
            throw new TypeError(`duplicate compiled skill ${compiled.definition.id}`);
        }

        this.#programs.set(definition, compiled);

        return compiled;
    }

    get(definition: SkillDefinition): CompiledSkill {
        this.#registration.assertUsable();
        const compiled = this.#programs.get(definition);

        if (compiled === undefined) {
            throw new TypeError(`unregistered skill ${definition.id}`);
        }

        return compiled;
    }
}

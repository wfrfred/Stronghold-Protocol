import type { Unit } from "../../unit/unit.js";
import type {
    ProjectileContactContext,
    ProjectileQueryContext,
    ProjectileStopContext,
} from "./context.js";

declare const projectileStateType: unique symbol;

export interface ProjectileDefinitionRef<S extends object> {
    readonly id: string;
    readonly [projectileStateType]: (state: S) => S;
}

export interface ProjectileDefinition<S extends object> {
    readonly ref: ProjectileDefinitionRef<S>;
    readonly initialize: () => S;
    readonly acceptsContact: (context: ProjectileQueryContext<S>, target: Unit) => boolean;
    readonly contact?: (context: ProjectileContactContext<S>) => undefined;
    readonly stop?: (context: ProjectileStopContext<S>) => undefined;
}

export function createProjectileDefinition<S extends object>(definition: {
    readonly id: string;
    readonly initialize: () => S;
    readonly acceptsContact: (context: ProjectileQueryContext<NoInfer<S>>, target: Unit) => boolean;
    readonly contact?: (context: ProjectileContactContext<NoInfer<S>>) => undefined;
    readonly stop?: (context: ProjectileStopContext<NoInfer<S>>) => undefined;
}): ProjectileDefinition<S> {
    if (definition.id.length === 0) {
        throw new TypeError("projectile definition identity must be nonempty");
    }

    return {
        ref: { id: definition.id } as ProjectileDefinitionRef<S>,
        initialize: definition.initialize,
        acceptsContact: definition.acceptsContact,
        ...(definition.contact === undefined ? {} : { contact: definition.contact }),
        ...(definition.stop === undefined ? {} : { stop: definition.stop }),
    };
}

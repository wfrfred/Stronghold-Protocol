import type { Unit } from "../../unit/unit.js";
import type {
    ProjectileContactContext,
    ProjectileQueryContext,
    ProjectileStopContext,
} from "./context.js";

declare const projectileStateType: unique symbol;

export interface ProjectileProgramRef<S extends object> {
    readonly id: string;
    readonly [projectileStateType]: (state: S) => S;
}

export interface ProjectileProgram<S extends object> {
    readonly ref: ProjectileProgramRef<S>;
    readonly initialize: () => S;
    readonly ownState: (value: unknown) => S;
    readonly acceptsContact: (context: ProjectileQueryContext<S>, target: Unit) => boolean;
    readonly contact?: (context: ProjectileContactContext<S>) => undefined;
    readonly stop?: (context: ProjectileStopContext<S>) => undefined;
}

export function createProjectileProgram<S extends object>(definition: {
    readonly id: string;
    readonly initialize: () => S;
    readonly ownState: (value: unknown) => NoInfer<S>;
    readonly acceptsContact: (context: ProjectileQueryContext<NoInfer<S>>, target: Unit) => boolean;
    readonly contact?: (context: ProjectileContactContext<NoInfer<S>>) => undefined;
    readonly stop?: (context: ProjectileStopContext<NoInfer<S>>) => undefined;
}): ProjectileProgram<S> {
    if (definition.id.length === 0) {
        throw new TypeError("projectile program identity must be nonempty");
    }

    return Object.freeze({
        ref: Object.freeze({ id: definition.id }) as ProjectileProgramRef<S>,
        initialize: definition.initialize,
        ownState: definition.ownState,
        acceptsContact: definition.acceptsContact,
        ...(definition.contact === undefined ? {} : { contact: definition.contact }),
        ...(definition.stop === undefined ? {} : { stop: definition.stop }),
    });
}

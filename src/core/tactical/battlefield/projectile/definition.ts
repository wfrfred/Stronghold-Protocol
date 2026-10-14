import type { State as BattleState } from "../../battle/state.js";
import type { Unit } from "../../unit/unit.js";
import type {
    ProjectileContactContext,
    ProjectileQueryContext,
    ProjectileStopContext,
} from "./context.js";

export interface Definition<S extends object> {
    readonly id: string;
    readonly initialize: () => S;
    readonly acceptsContact: (context: ProjectileQueryContext<S>, target: Unit) => boolean;
    readonly contact?: (state: BattleState, context: ProjectileContactContext<S>) => BattleState;
    readonly stop?: (state: BattleState, context: ProjectileStopContext<S>) => BattleState;
}

export function createDefinition<S extends object>(definition: {
    readonly id: string;
    readonly initialize: () => S;
    readonly acceptsContact: (context: ProjectileQueryContext<NoInfer<S>>, target: Unit) => boolean;
    readonly contact?: (
        state: BattleState,
        context: ProjectileContactContext<NoInfer<S>>,
    ) => BattleState;
    readonly stop?: (state: BattleState, context: ProjectileStopContext<NoInfer<S>>) => BattleState;
}): Definition<S> {
    if (definition.id.length === 0) {
        throw new TypeError("projectile definition identity must be nonempty");
    }

    return {
        id: definition.id,
        initialize: definition.initialize,
        acceptsContact: definition.acceptsContact,
        ...(definition.contact === undefined ? {} : { contact: definition.contact }),
        ...(definition.stop === undefined ? {} : { stop: definition.stop }),
    };
}

import type { WorldPosition } from "../geometry/coordinate.js";
import type { State as BattleState, Result } from "../battle/state.js";
import { initializers, type Definitions, type Product } from "./capability/catalog.js";
import { Effects } from "./effect/effects.js";
import type { Unit, Definition, Id } from "./unit.js";

export interface Input<D extends Definition & Partial<Definitions> = Definition> {
    readonly id: Id;
    readonly definition: D;
    readonly position: WorldPosition;
    readonly effects?: Effects;
}

export function initialize<D extends Definition & Partial<Definitions>>(
    battle: BattleState,
    input: Input<D>,
): Result<Unit & Product<D>>;
export function initialize(battle: BattleState, input: Input): Result<Unit> {
    const states: Record<string, unknown> = {};

    for (const key of Object.keys(initializers) as (keyof typeof initializers)[]) {
        if (!(key in input.definition)) {
            continue;
        }

        const definition: unknown = Reflect.get(input.definition, key);

        if (definition === undefined || definition === null) {
            throw new TypeError(`capability ${key} requires a definition`);
        }

        const initialized = initializers[key](battle, definition as never);
        battle = initialized.state;
        states[key] = initialized.value;
    }

    return {
        state: battle,
        value: {
            id: input.id,
            lifecycle: "PRESENT",
            definition: input.definition,
            position: input.position,
            effects: input.effects ?? Effects.empty(),
            ...states,
        },
    };
}

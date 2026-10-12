import { createNavigationFieldCache } from "./navigation/cache.js";
import type { Unit } from "../unit/unit.js";
import type {
    Battlefield,
    BattlefieldChange,
    BattlefieldChangeResult,
    BattlefieldRuntimeOptions,
    BattlefieldView,
} from "./contract.js";
import { create, transition, type State } from "./state.js";
import { view } from "./view.js";

export class BattlefieldRuntime<U extends Unit = Unit> {
    readonly #fieldCache = createNavigationFieldCache();
    readonly #views = new WeakMap<State<U>, BattlefieldView<U>>();

    #state: State<U>;
    #draft: State<U>;

    private constructor(state: State<U>) {
        this.#state = state;
        this.#draft = state;
    }

    static create<U extends Unit>(options: BattlefieldRuntimeOptions): BattlefieldRuntime<U> {
        return new BattlefieldRuntime<U>(create<U>(options));
    }

    snapshot(version: "state" | "draft"): BattlefieldView<U> {
        const state = version === "state" ? this.#state : this.#draft;
        let snapshot = this.#views.get(state);

        if (snapshot === undefined) {
            snapshot = view(state, this.#fieldCache);
            this.#views.set(state, snapshot);
        }

        return snapshot;
    }

    advance(changes: readonly BattlefieldChange<U>[]): BattlefieldChangeResult<U> {
        const result = transition<U>(this.#draft, changes);
        this.#draft = result.state;

        return result.facts;
    }

    apply(): void {
        this.#state = this.#draft;
    }

    drop(): void {
        this.#draft = this.#state;
    }
}

export function createBattlefieldRuntime<U extends Unit = Unit>(
    options: BattlefieldRuntimeOptions,
): Battlefield<U> {
    return BattlefieldRuntime.create<U>(options);
}

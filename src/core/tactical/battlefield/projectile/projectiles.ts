import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { Store } from "../../../common/collection/store.js";
import type { Query } from "../../../common/query.js";
import type { Ref } from "../../../common/ref.js";
import type { Definition } from "./definition.js";
import type { Projectile, ProjectileId, Snapshot, View } from "./projectile.js";

export class Projectiles {
    static readonly #empty = new Projectiles(Store.empty<ProjectileId, View>());

    readonly #entries: Store<ProjectileId, View>;

    private constructor(entries: Store<ProjectileId, View>) {
        this.#entries = entries;
    }

    static empty(): Projectiles {
        return Projectiles.#empty;
    }

    get size(): number {
        return this.#entries.size;
    }

    get<P extends View>(reference: Ref<P>): P | undefined;
    get(id: ProjectileId): View | undefined;
    get<S extends object>(id: ProjectileId, definition: Definition<S>): Projectile<S> | undefined;
    get<S extends object, P extends View>(
        identity: ProjectileId | Ref<P>,
        definition?: Definition<S>,
    ): View | Projectile<S> | P | undefined {
        const id = typeof identity === "number" ? identity : identity.id;
        const projectile = this.#entries.get(id);

        if (typeof identity !== "number") {
            return projectile;
        }
        if (definition === undefined) {
            return projectile;
        }

        const restored: Projectile<S> | undefined =
            projectile?.definition === definition ? (projectile as Projectile<S>) : undefined;

        return restored;
    }

    read<R>(
        id: ProjectileId,
        reader: <S extends object>(projectile: Projectile<S>) => R,
    ): R | undefined {
        const projectile = this.#entries.get(id);

        return projectile === undefined ? undefined : reader(projectile as Projectile);
    }

    values(): Query<View> {
        return this.#entries.values();
    }

    keys(): Query<ProjectileId> {
        return this.#entries.keys();
    }

    snapshot(): readonly Snapshot[] {
        return this.#entries
            .values()
            .map((projectile) => projectile as Snapshot)
            .toArray();
    }

    add<S extends object>(projectile: Projectile<S>): Projectiles {
        assertNonnegativeSafeInteger(projectile.id, "projectile id");

        if (this.#entries.get(projectile.id) !== undefined) {
            throw new RangeError(`duplicate projectile: ${projectile.id}`);
        }

        return new Projectiles(this.#entries.add(projectile.id, projectile));
    }

    replace<S extends object>(
        reference: Ref<Projectile<S>>,
        projectile: NoInfer<Projectile<S>>,
    ): Projectiles {
        const previous = this.get(reference);

        if (previous === undefined) {
            throw new RangeError(`unknown projectile: ${reference.id}`);
        }
        if (projectile.id !== reference.id) {
            throw new TypeError("projectile identity cannot change");
        }
        if (previous.definition !== projectile.definition) {
            throw new RangeError("projectile definition cannot change during update");
        }
        if (previous === projectile) {
            return this;
        }

        return new Projectiles(this.#entries.replace(reference.id, projectile));
    }

    remove(id: ProjectileId): Projectiles {
        if (this.#entries.get(id) === undefined) {
            throw new RangeError(`unknown projectile: ${id}`);
        }

        return new Projectiles(this.#entries.remove(id));
    }
}

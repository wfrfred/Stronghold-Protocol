import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { Definition } from "./definition.js";
import type { Projectile, ProjectileId } from "./projectile.js";

type StoredProjectile = Omit<Projectile, "definition" | "state"> & {
    readonly definition: Pick<Definition<object>, "id">;
    readonly state: object;
};

export class Projectiles {
    static readonly #empty = new Projectiles(new Map());

    readonly #entries: ReadonlyMap<ProjectileId, StoredProjectile>;

    private constructor(entries: ReadonlyMap<ProjectileId, StoredProjectile>) {
        this.#entries = entries;
    }

    static empty(): Projectiles {
        return Projectiles.#empty;
    }

    get size(): number {
        return this.#entries.size;
    }

    get(id: ProjectileId): StoredProjectile | undefined;
    get<S extends object>(id: ProjectileId, definition: Definition<S>): Projectile<S> | undefined;
    get<S extends object>(
        id: ProjectileId,
        definition?: Definition<S>,
    ): StoredProjectile | Projectile<S> | undefined {
        const projectile = this.#entries.get(id);

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

    values(): readonly StoredProjectile[] {
        return [...this.#entries.values()];
    }

    keys(): readonly ProjectileId[] {
        return [...this.#entries.keys()];
    }

    add<S extends object>(projectile: Projectile<S>): Projectiles {
        assertNonnegativeSafeInteger(projectile.id, "projectile id");

        if (this.#entries.has(projectile.id)) {
            throw new RangeError(`duplicate projectile: ${projectile.id}`);
        }

        return new Projectiles(new Map([...this.#entries, [projectile.id, projectile]]));
    }

    replace<S extends object>(projectile: Projectile<S>): Projectiles {
        const previous = this.#entries.get(projectile.id);

        if (previous === undefined) {
            throw new RangeError(`unknown projectile: ${projectile.id}`);
        }
        if (previous.definition !== projectile.definition) {
            throw new RangeError("projectile definition cannot change during update");
        }
        if (previous === projectile) {
            return this;
        }

        return new Projectiles(new Map([...this.#entries, [projectile.id, projectile]]));
    }

    remove(id: ProjectileId): Projectiles {
        if (!this.#entries.has(id)) {
            throw new RangeError(`unknown projectile: ${id}`);
        }

        const entries = new Map(this.#entries);
        entries.delete(id);

        return new Projectiles(entries);
    }
}

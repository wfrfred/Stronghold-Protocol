import type { BattlefieldChange } from "../../contract.js";
import type { ProjectileId, ProjectileInstance, ProjectileView } from "../state.js";

export function updateProjectileInstance<S extends object>(
    instance: ProjectileInstance<S>,
    change: Partial<
        Pick<
            ProjectileInstance<S>,
            "position" | "destination" | "lastAdvancedTick" | "progress" | "hitUnitIds" | "state"
        >
    >,
): ProjectileInstance<S> {
    return { ...instance, ...change };
}

export class ProjectileWork {
    readonly #baseline: ProjectileView;
    readonly #instances: Map<ProjectileId, ProjectileInstance>;
    readonly #updated = new Set<ProjectileId>();

    constructor(battlefield: ProjectileView) {
        this.#baseline = battlefield;
        this.#instances = new Map(
            battlefield.projectileIds.map((id) => [id, battlefield.getProjectile(id)!]),
        );
    }

    get ids(): Iterable<ProjectileId> {
        return this.#instances.keys();
    }

    get(id: ProjectileId): ProjectileInstance | undefined {
        return this.#instances.get(id);
    }

    add(instance: ProjectileInstance): void {
        if (this.#instances.has(instance.id)) {
            throw new RangeError(`duplicate projectile: ${instance.id}`);
        }

        this.#instances.set(instance.id, instance);
        this.#updated.add(instance.id);
    }

    update(instance: ProjectileInstance): void {
        const current = this.#instances.get(instance.id);

        if (current !== undefined && current !== instance) {
            this.#instances.set(instance.id, instance);
            this.#updated.add(instance.id);
        }
    }

    remove(id: ProjectileId): void {
        if (this.#instances.delete(id)) {
            this.#updated.add(id);
        }
    }

    changes(): readonly BattlefieldChange[] {
        const changes: BattlefieldChange[] = [];

        for (const id of this.#updated) {
            const previous = this.#baseline.getProjectile(id);
            const current = this.#instances.get(id);

            if (current === previous) {
                continue;
            }
            if (current === undefined) {
                changes.push({ type: "REMOVE_PROJECTILE", projectileId: id });
            } else {
                changes.push({
                    type: previous === undefined ? "REGISTER_PROJECTILE" : "UPDATE_PROJECTILE",
                    projectile: current,
                });
            }
        }

        return changes;
    }
}

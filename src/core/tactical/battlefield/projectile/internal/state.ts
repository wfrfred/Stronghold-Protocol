import { ownDataRecord } from "../../../../common/immutable-data.js";
import { createWorldPosition } from "../../../geometry/coordinate.js";
import { createRangeGeometry } from "../../../geometry/shape.js";
import type { BattlefieldChange } from "../../contract.js";
import type {
    ProjectileId,
    ProjectileInstance,
    ProjectileState,
    ProjectileView,
} from "../state.js";

const ownedInstances = new WeakSet<ProjectileInstance>();
const ownedStates = new WeakSet<ProjectileState>();

export function ownProjectileInstance<S extends object>(
    instance: ProjectileInstance<S>,
): ProjectileInstance<S> {
    if (ownedInstances.has(instance)) {
        return instance;
    }

    const owned: ProjectileInstance<S> = Object.freeze({
        ...instance,
        position: createWorldPosition(instance.position[0], instance.position[1]),
        destination: createWorldPosition(instance.destination[0], instance.destination[1]),
        contactRange: createRangeGeometry(instance.contactRange),
        progress: Object.freeze({ ...instance.progress }),
        hitUnitIds: ownDataRecord({ ids: instance.hitUnitIds }, "projectile hit identities").ids,
        state: ownDataRecord(instance.state, "projectile state"),
    });
    ownedInstances.add(owned);

    return owned;
}

export function updateProjectileInstance<S extends object>(
    instance: ProjectileInstance<S>,
    change: Partial<
        Pick<
            ProjectileInstance<S>,
            "position" | "destination" | "lastAdvancedTick" | "progress" | "hitUnitIds" | "state"
        >
    >,
): ProjectileInstance<S> {
    const updated = Object.freeze({
        ...instance,
        ...change,
        position:
            change.position === undefined || change.position === instance.position
                ? instance.position
                : createWorldPosition(change.position[0], change.position[1]),
        destination:
            change.destination === undefined || change.destination === instance.destination
                ? instance.destination
                : createWorldPosition(change.destination[0], change.destination[1]),
        progress:
            change.progress === undefined || change.progress === instance.progress
                ? instance.progress
                : Object.freeze({ ...change.progress }),
        hitUnitIds:
            change.hitUnitIds === undefined || change.hitUnitIds === instance.hitUnitIds
                ? instance.hitUnitIds
                : ownDataRecord({ ids: change.hitUnitIds }, "projectile hit identities").ids,
        state:
            change.state === undefined || change.state === instance.state
                ? instance.state
                : ownDataRecord(change.state, "projectile state"),
    });
    ownedInstances.add(updated);

    return updated;
}

export function ownProjectileState(state: ProjectileState): ProjectileState {
    if (ownedStates.has(state)) {
        return state;
    }

    const instances: ProjectileInstance[] = [];
    const ids = new Set<ProjectileId>();

    for (let index = 0; index < state.instances.length; index++) {
        if (!Object.hasOwn(state.instances, index)) {
            throw new TypeError("projectile instances must be dense");
        }

        const instance = state.instances[index]!;

        if (ids.has(instance.id) || instance.id >= state.nextProjectileId) {
            throw new TypeError("invalid projectile allocation progress");
        }

        ids.add(instance.id);
        instances.push(ownProjectileInstance(instance));
    }

    const owned = Object.freeze({
        nextProjectileId: state.nextProjectileId,
        instances: Object.freeze(instances),
    });
    ownedStates.add(owned);

    return owned;
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

        this.#instances.set(instance.id, ownProjectileInstance(instance));
        this.#updated.add(instance.id);
    }

    update(instance: ProjectileInstance): void {
        const current = this.#instances.get(instance.id);

        if (current !== undefined && current !== instance) {
            this.#instances.set(instance.id, ownProjectileInstance(instance));
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

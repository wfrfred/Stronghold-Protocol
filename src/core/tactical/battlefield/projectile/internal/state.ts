import { ownDataRecord } from "../../../../common/immutable-data.js";
import { createWorldPosition } from "../../../geometry/coordinate.js";
import { createRangeGeometry } from "../../../geometry/shape.js";
import type { ProjectileId, ProjectileInstance, ProjectileState } from "../state.js";

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
    readonly #instances: Map<ProjectileId, ProjectileInstance>;
    #nextProjectileId: ProjectileId;
    #snapshot: ProjectileState | null;

    constructor(state: ProjectileState) {
        const owned = ownProjectileState(state);
        this.#instances = new Map(owned.instances.map((instance) => [instance.id, instance]));
        this.#nextProjectileId = owned.nextProjectileId;
        this.#snapshot = owned;
    }

    get nextProjectileId(): ProjectileId {
        return this.#nextProjectileId;
    }

    get ids(): Iterable<ProjectileId> {
        return this.#instances.keys();
    }

    get(id: ProjectileId): ProjectileInstance | undefined {
        return this.#instances.get(id);
    }

    add(instance: ProjectileInstance): void {
        this.#instances.set(instance.id, ownProjectileInstance(instance));
        this.#nextProjectileId = instance.id + 1;
        this.#snapshot = null;
    }

    update(instance: ProjectileInstance): void {
        const current = this.#instances.get(instance.id);

        if (current !== undefined && current !== instance) {
            this.#instances.set(instance.id, ownProjectileInstance(instance));
            this.#snapshot = null;
        }
    }

    remove(id: ProjectileId): void {
        if (this.#instances.delete(id)) {
            this.#snapshot = null;
        }
    }

    result(): ProjectileState {
        if (this.#snapshot === null) {
            this.#snapshot = Object.freeze({
                nextProjectileId: this.#nextProjectileId,
                instances: Object.freeze([...this.#instances.values()]),
            });
            ownedStates.add(this.#snapshot);
        }

        return this.#snapshot;
    }
}

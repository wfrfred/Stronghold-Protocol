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
    if (!Object.isFrozen(instance.programRef) || instance.programRef.id.length === 0) {
        throw new TypeError("projectile program references must be immutable and nonempty");
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

export function replaceProjectile(
    state: ProjectileState,
    instance: ProjectileInstance,
): ProjectileState {
    return ownProjectileState({
        ...state,
        instances: state.instances.map((current) =>
            current.id === instance.id ? instance : current,
        ),
    });
}

export function removeProjectile(state: ProjectileState, id: ProjectileId): ProjectileState {
    return ownProjectileState({
        ...state,
        instances: state.instances.filter((instance) => instance.id !== id),
    });
}

import type { UnitId } from "../../../unit/unit.js";
import type { EffectSourceReceiver, EffectSourceStateValue } from "../state.js";

interface ReceiverRevision {
    readonly binding: EffectSourceReceiver;
    readonly previous: ReceiverRevision | null;
}

type ReceiverQuery = () => readonly EffectSourceReceiver[];

const receiverViews = new WeakMap<EffectSourceStateValue, ReceiverQuery>();

export function createEffectSourceReceiverView(
    state: EffectSourceStateValue,
    receivers: ReceiverQuery,
    changes: Partial<Pick<EffectSourceStateValue, "initialized" | "finished" | "state">> = {},
): EffectSourceStateValue {
    const view = Object.freeze({
        programRef: state.programRef,
        sourceUnitId: state.sourceUnitId,
        state: changes.state ?? state.state,
        get receivers() {
            return receivers();
        },
        initialized: changes.initialized ?? state.initialized,
        finished: changes.finished ?? state.finished,
    });
    receiverViews.set(view, receivers);

    return view;
}

export function updateEffectSourceReceiverView(
    state: EffectSourceStateValue,
    changes: Partial<Pick<EffectSourceStateValue, "initialized" | "finished" | "state">>,
): EffectSourceStateValue | undefined {
    const receivers = receiverViews.get(state);

    return receivers === undefined
        ? undefined
        : createEffectSourceReceiverView(state, receivers, changes);
}

export class EffectSourceReceiverWork {
    readonly #initial: readonly EffectSourceReceiver[];
    readonly #bindings: Map<UnitId, EffectSourceReceiver>;
    #revision: ReceiverRevision | null = null;
    #ids: readonly UnitId[] | undefined;

    constructor(initial: readonly EffectSourceReceiver[]) {
        this.#initial = initial;
        this.#bindings = new Map(initial.map((binding) => [binding.unitId, binding]));
        this.#ids = initial.map((binding) => binding.unitId);
    }

    get(unitId: UnitId): EffectSourceReceiver | undefined {
        return this.#bindings.get(unitId);
    }

    ids(): readonly UnitId[] {
        this.#ids ??= [...this.#bindings.keys()].sort((left, right) => left - right);

        return this.#ids;
    }

    set(binding: EffectSourceReceiver): () => readonly EffectSourceReceiver[] {
        const owned = Object.freeze({
            unitId: binding.unitId,
            address: binding.address === null ? null : Object.freeze({ ...binding.address }),
            installationAttempts: binding.installationAttempts,
        });

        if (!this.#bindings.has(binding.unitId)) {
            this.#ids = undefined;
        }

        this.#bindings.set(binding.unitId, owned);
        this.#revision = { binding: owned, previous: this.#revision };

        return this.capture();
    }

    capture(): () => readonly EffectSourceReceiver[] {
        const initial = this.#initial;
        const revision = this.#revision;
        let receivers: readonly EffectSourceReceiver[] | undefined =
            revision === null ? initial : undefined;

        return () => {
            if (receivers === undefined) {
                const bindings = new Map(initial.map((binding) => [binding.unitId, binding]));
                const changed = new Set<UnitId>();
                let added = false;

                for (let current = revision; current !== null; current = current.previous) {
                    if (!changed.has(current.binding.unitId)) {
                        added ||= !bindings.has(current.binding.unitId);
                        bindings.set(current.binding.unitId, current.binding);
                        changed.add(current.binding.unitId);
                    }
                }

                const values = [...bindings.values()];

                if (added) {
                    values.sort((left, right) => left.unitId - right.unitId);
                }

                receivers = Object.freeze(values);
            }

            return receivers;
        };
    }
}

import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { ownDataRecord } from "../../../common/immutable-data.js";
import type { MechanismRuntime } from "../mechanism.js";
import type { UnitId } from "../../unit/unit.js";
import type { EffectAddress } from "../../unit/capability/effects/instance.js";
import type { EffectSourceProgramRef } from "./program.js";

export interface EffectSourceReceiver {
    readonly unitId: UnitId;
    readonly address: EffectAddress | null;
    readonly installationAttempts: number;
}

export interface EffectSourceStateValue {
    readonly programRef: { readonly id: string };
    readonly sourceUnitId: UnitId | null;
    readonly state: object;
    readonly receivers: readonly EffectSourceReceiver[];
    readonly initialized: boolean;
    readonly finished: boolean;
}

export interface EffectSourceMechanism extends MechanismRuntime {
    readonly effectSource: EffectSourceStateValue;
}

export interface TypedEffectSourceMechanism<S extends object> extends EffectSourceMechanism {
    readonly effectSource: EffectSourceStateValue & {
        readonly programRef: EffectSourceProgramRef<S>;
        readonly state: S;
    };
}

const ownedStates = new WeakSet<EffectSourceStateValue>();
const ownedReceiverArrays = new WeakSet<readonly EffectSourceReceiver[]>();

export function hasEffectSource(mechanism: MechanismRuntime): mechanism is EffectSourceMechanism {
    return "effectSource" in mechanism;
}

export function copyEffectSourceState(state: EffectSourceStateValue): EffectSourceStateValue {
    if (ownedStates.has(state)) {
        return state;
    }

    const receivers = copyReceivers(state.receivers);
    const owned = Object.freeze({
        programRef: state.programRef,
        sourceUnitId: state.sourceUnitId,
        state: ownDataRecord(state.state, "effect source state"),
        receivers,
        initialized: state.initialized,
        finished: state.finished,
    });

    ownedStates.add(owned);

    return owned;
}

function copyReceivers(
    receivers: readonly EffectSourceReceiver[],
): readonly EffectSourceReceiver[] {
    if (ownedReceiverArrays.has(receivers)) {
        return receivers;
    }

    const ids = new Set<UnitId>();
    const copied = ownDataRecord({ receivers }, "effect source receivers").receivers.map(
        (receiver) => {
            if (ids.has(receiver.unitId)) {
                throw new TypeError("effect source receiver identities must be unique");
            }

            assertNonnegativeSafeInteger(
                receiver.installationAttempts,
                "effect source installation attempts",
            );

            if (receiver.address !== null && receiver.address.unitId !== receiver.unitId) {
                throw new TypeError("effect source receiver address must match its unit");
            }

            ids.add(receiver.unitId);

            return Object.freeze({
                unitId: receiver.unitId,
                address: receiver.address === null ? null : Object.freeze({ ...receiver.address }),
                installationAttempts: receiver.installationAttempts,
            });
        },
    );
    const owned = Object.freeze(copied);
    ownedReceiverArrays.add(owned);

    return owned;
}

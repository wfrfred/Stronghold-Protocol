import { assertNonnegativeSafeInteger } from "./assert.js";

export function sort<T>(
    candidates: Iterable<T>,
    compare: (left: T, right: T) => number,
): readonly T[] {
    return [...candidates].sort(compare);
}

export function topK<T>(
    candidates: Iterable<T>,
    k: number,
    compare: (left: T, right: T) => number,
): readonly T[] {
    assertNonnegativeSafeInteger(k, "k");

    if (k === 0) {
        return [];
    }

    const heap: { readonly value: T; readonly index: number }[] = [];
    const order = (left: (typeof heap)[number], right: (typeof heap)[number]) =>
        compare(left.value, right.value) || left.index - right.index;

    let index = 0;

    for (const value of candidates) {
        const entry = { value, index: index++ };

        if (heap.length < k) {
            heap.push(entry);
            let child = heap.length - 1;

            while (child > 0) {
                const parent = Math.floor((child - 1) / 2);

                if (order(heap[child]!, heap[parent]!) <= 0) {
                    break;
                }

                [heap[child], heap[parent]] = [heap[parent]!, heap[child]!];
                child = parent;
            }
        } else if (order(entry, heap[0]!) < 0) {
            heap[0] = entry;
            let parent = 0;

            while (parent * 2 + 1 < heap.length) {
                const left = parent * 2 + 1;
                const right = left + 1;
                let worst = left;

                if (right < heap.length && order(heap[right]!, heap[left]!) > 0) {
                    worst = right;
                }
                if (order(heap[parent]!, heap[worst]!) >= 0) {
                    break;
                }

                [heap[parent], heap[worst]] = [heap[worst]!, heap[parent]!];
                parent = worst;
            }
        }
    }

    return heap.sort(order).map((entry) => entry.value);
}

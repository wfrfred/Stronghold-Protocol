export class ResourceRegistration {
    #sealed = false;
    #failed = false;

    assertUsable(): void {
        if (this.#failed) {
            throw new TypeError("failed resource construction must be discarded");
        }
    }

    assertWritable(): void {
        this.assertUsable();

        if (this.#sealed) {
            throw new TypeError("resource registration is sealed");
        }
    }

    fail(): void {
        this.#failed = true;
    }

    seal(): void {
        this.assertUsable();
        this.#sealed = true;
    }
}

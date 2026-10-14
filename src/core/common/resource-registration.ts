export class ResourceRegistration {
    #sealed = false;

    assertWritable(): void {
        if (this.#sealed) {
            throw new TypeError("resource registration is sealed");
        }
    }

    seal(): void {
        this.#sealed = true;
    }
}

export class SingleFlight<T> {
  readonly #runs = new Map<string, Promise<T>>()

  run(key: string, operation: () => Promise<T> | T): Promise<T> {
    const existing = this.#runs.get(key)
    if (existing !== undefined) return existing

    const run = Promise.resolve().then(operation)
    this.#runs.set(key, run)
    void run.then(
      () => this.#delete(key, run),
      () => this.#delete(key, run),
    )
    return run
  }

  #delete(key: string, run: Promise<T>): void {
    if (this.#runs.get(key) === run) this.#runs.delete(key)
  }
}

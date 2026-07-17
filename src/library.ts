import { resolve } from "std/path";
import { scanLibrary } from "./scanner.ts";
import type { Library, MediaFile } from "./types.ts";

export class LibraryStore {
  #libraryFile: string;
  #mediaDir: string;
  #library: Library | null = null;
  #itemsById = new Map<string, MediaFile>();
  #rescanPromise: Promise<Library> | null = null;

  constructor(mediaDir: string, libraryFile: string) {
    this.#mediaDir = resolve(mediaDir);
    this.#libraryFile = resolve(libraryFile);
  }

  get mediaDir(): string {
    return this.#mediaDir;
  }

  async load(): Promise<Library> {
    if (this.#library) {
      return this.#library;
    }

    try {
      const raw = await Deno.readTextFile(this.#libraryFile);
      const library = JSON.parse(raw) as Library;
      if (library.mediaDir === this.#mediaDir) {
        return this.setLibrary(library);
      }
    } catch {
      // Missing or invalid cache; rescan below.
    }

    return await this.rescan();
  }

  async rescan(): Promise<Library> {
    if (this.#rescanPromise) {
      return await this.#rescanPromise;
    }

    this.#rescanPromise = this.#rescan();
    try {
      return await this.#rescanPromise;
    } finally {
      this.#rescanPromise = null;
    }
  }

  async #rescan(): Promise<Library> {
    const previous = await this.loadPreviousLibrary();
    const library = await scanLibrary(this.#mediaDir, previous);
    await Deno.writeTextFile(
      this.#libraryFile,
      `${JSON.stringify(library, null, 2)}\n`,
    );
    return this.setLibrary(library);
  }

  async loadPreviousLibrary(): Promise<Library | undefined> {
    if (this.#library?.mediaDir === this.#mediaDir) {
      return this.#library;
    }

    try {
      const raw = await Deno.readTextFile(this.#libraryFile);
      const library = JSON.parse(raw) as Library;
      return library.mediaDir === this.#mediaDir ? library : undefined;
    } catch {
      return undefined;
    }
  }

  async find(id: string): Promise<MediaFile | undefined> {
    await this.load();
    return this.#itemsById.get(id);
  }

  setLibrary(library: Library): Library {
    this.#library = library;
    this.#itemsById = new Map(library.items.map((item) => [item.id, item]));
    return library;
  }
}

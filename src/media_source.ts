import { Source } from "mediabunny";

type ReadResult = {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
};

export class DenoFileSource extends Source {
  #path: string;
  #size?: number;

  constructor(path: string, size?: number) {
    super();
    this.#path = path;
    this.#size = size;
  }

  _getFileSize(): number | undefined {
    return this.#size;
  }

  async _read(start: number, end: number): Promise<ReadResult> {
    const length = Math.max(0, end - start);
    const file = await Deno.open(this.#path, { read: true });

    try {
      await file.seek(start, Deno.SeekMode.Start);

      const bytes = new Uint8Array(length);
      let offset = 0;

      while (offset < length) {
        const bytesRead = await file.read(bytes.subarray(offset));
        if (bytesRead === null) {
          break;
        }
        offset += bytesRead;
      }

      const result = offset === length ? bytes : bytes.subarray(0, offset);
      (this as unknown as {
        _dispatchRead(start: number, end: number): void;
      })._dispatchRead(start, start + result.byteLength);

      return {
        bytes: result,
        view: new DataView(result.buffer, result.byteOffset, result.byteLength),
        offset: start,
      };
    } finally {
      file.close();
    }
  }

  _dispose(): void {
  }
}

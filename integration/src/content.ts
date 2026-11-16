import { createHash } from "node:crypto";
import type { ProtonDriveClient } from "@protontech/drive-sdk";

export async function readRevision(
  sdk: Pick<ProtonDriveClient, "getFileRevisionDownloader">,
  revision: string,
  write?: (chunk: Uint8Array) => Promise<void>,
): Promise<{ kind: "file"; size: number; sha1: string }> {
  const hash = createHash("sha1");
  let size = 0;
  const downloader = await sdk.getFileRevisionDownloader(revision);
  const controller = downloader.downloadToStream(
    new WritableStream<Uint8Array>({
      async write(chunk) {
        hash.update(chunk);
        size += chunk.byteLength;
        if (!Number.isSafeInteger(size)) {
          throw new Error("Remote file is too large to represent safely.");
        }
        await write?.(chunk);
      },
    }),
  );
  await controller.completion();
  return { kind: "file", size, sha1: hash.digest("hex") };
}

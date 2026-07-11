import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TELEGRAM_GUEST_MEDIA_TTL_MS,
  TelegramGuestMediaStore,
} from "../src/telegram/guest-media";

test("publishes approved guest media through a ranged temporary URL", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-guest-media-"));
  const artifactsDir = join(root, "artifacts");
  const spoolDir = join(root, "spool");
  const sourcePath = join(artifactsDir, "chart.png");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(sourcePath, "0123456789");
  const canonicalArtifactsDir = await realpath(artifactsDir);

  try {
    const store = new TelegramGuestMediaStore({
      publicUrl: "https://operator.example.com",
      spoolDir,
      attachmentValidation: {
        workdir: root,
        allowedRoots: [canonicalArtifactsDir],
        maxDocumentBytes: 1_000,
      },
    });
    const publishedAt = Date.now();
    const published = await store.publish({
      path: sourcePath,
      fileName: "chart.png",
      caption: "Generated chart",
      kind: "photo",
    });

    expect(published.url).toMatch(/^https:\/\/operator\.example\.com\/guest-media\/[a-z0-9]+-[A-Za-z0-9_-]{24}\/chart\.png$/);
    expect(published.expiresAt - publishedAt).toBeGreaterThan(TELEGRAM_GUEST_MEDIA_TTL_MS - 1_000);
    expect(published.expiresAt - publishedAt).toBeLessThanOrEqual(TELEGRAM_GUEST_MEDIA_TTL_MS + 1_000);

    const fullResponse = await store.handleRequest(new Request(published.url));
    expect(fullResponse?.status).toBe(200);
    expect(fullResponse?.headers.get("content-type")).toBe("image/png");
    expect(fullResponse?.headers.get("cache-control")).toBe(
      "public, max-age=600, s-maxage=600, immutable",
    );
    expect(await fullResponse?.text()).toBe("0123456789");

    const rangeResponse = await store.handleRequest(new Request(published.url, {
      headers: { range: "bytes=2-5" },
    }));
    expect(rangeResponse?.status).toBe(206);
    expect(rangeResponse?.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await rangeResponse?.text()).toBe("2345");

    const expiredResponse = await store.handleRequest(new Request(published.url), published.expiresAt);
    expect(expiredResponse?.status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unsupported guest attachments and files outside approved roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "operator-guest-media-reject-"));
  const artifactsDir = join(root, "artifacts");
  const outsidePath = join(root, "outside.png");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(outsidePath, "not allowed");
  const canonicalArtifactsDir = await realpath(artifactsDir);

  try {
    const store = new TelegramGuestMediaStore({
      publicUrl: "https://operator.example.com",
      spoolDir: join(root, "spool"),
      attachmentValidation: {
        workdir: root,
        allowedRoots: [canonicalArtifactsDir],
        maxDocumentBytes: 1_000,
      },
    });

    await expect(store.publish({
      path: outsidePath,
      fileName: "outside.png",
      kind: "photo",
    })).rejects.toThrow(/allowed root/);

    await expect(store.publish({
      path: outsidePath,
      fileName: "report.pdf",
      kind: "document",
    })).rejects.toThrow(/does not support queued document/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

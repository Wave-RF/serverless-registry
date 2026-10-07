import { describe, expect, test } from "vitest";
import type { Env } from "..";
import { R2Registry } from "../src/registry/r2";

const imageManifestContentType = "application/vnd.oci.image.manifest.v1+json";

const plainManifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: imageManifestContentType,
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    digest: `sha256:${"0".repeat(64)}`,
    size: 0,
  },
  layers: [],
});

// A referrer: the same manifest shape plus a subject.
const subjectDigest = `sha256:${"1".repeat(64)}`;
const referrerManifest = JSON.stringify({
  ...JSON.parse(plainManifest),
  subject: {
    mediaType: imageManifestContentType,
    digest: subjectDigest,
    size: 0,
  },
});

async function sha256Digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `sha256:${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// A minimal in-memory bucket. Puts of keys in failOnce throw once, then succeed.
function fakeBucket(failOnce: Set<string>) {
  const objects = new Map<string, string>();
  const bucket = {
    head: async (key: string) => (objects.has(key) ? ({ key } as R2Object) : null),
    put: async (key: string, value: unknown, options?: R2PutOptions) => {
      if (failOnce.delete(key)) throw new Error(`simulated R2 failure for ${key}`);
      if (options?.onlyIf && objects.has(key)) return null;
      objects.set(key, typeof value === "string" ? value : "");
      return { key } as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

describe("manifest write ordering", () => {
  test("finishes the digest write before starting a mutable tag write", async () => {
    const events: string[] = [];
    const tagKey = "write-order/manifests/latest";
    const registry = {
      head: async () => null,
      put: async (key: string) => {
        if (key.includes("/manifests/")) {
          const kind = key === tagKey ? "tag" : "digest";
          events.push(`start:${kind}`);
          await Promise.resolve();
          events.push(`finish:${kind}`);
        }
        return {};
      },
    } as unknown as R2Bucket;
    const env = { REGISTRY: registry } as Env;

    const result = await new R2Registry(env).putManifestInner(
      "write-order",
      "latest",
      new Blob([plainManifest]).stream(),
      imageManifestContentType,
      false,
    );

    expect("response" in result).toBe(false);
    expect(events).toEqual(["start:digest", "finish:digest", "start:tag", "finish:tag"]);
  });

  test("finishes the digest write before starting a protected tag write", async () => {
    const events: string[] = [];
    const tagKey = "protected-write-order/manifests/v1.2.3";
    const registry = {
      head: async () => null,
      put: async (key: string) => {
        if (key.includes("/manifests/")) {
          const kind = key === tagKey ? "tag" : "digest";
          events.push(`start:${kind}`);
          await Promise.resolve();
          events.push(`finish:${kind}`);
        }
        return {};
      },
    } as unknown as R2Bucket;
    const env = {
      REGISTRY: registry,
      IMMUTABLE_TAG_PATTERN: String.raw`v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`,
    } as Env;
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: imageManifestContentType,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: `sha256:${"0".repeat(64)}`,
        size: 0,
      },
      layers: [],
    });

    const result = await new R2Registry(env).putManifestInner(
      "protected-write-order",
      "v1.2.3",
      new Blob([manifest]).stream(),
      imageManifestContentType,
      false,
    );

    expect("response" in result).toBe(false);
    expect(events).toEqual(["start:digest", "finish:digest", "start:tag", "finish:tag"]);
  });

  describe.each([
    { label: "mutable tag", tag: "latest", pattern: undefined },
    { label: "immutable tag", tag: "v1.2.3", pattern: String.raw`v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)` },
    { label: "digest reference", tag: undefined, pattern: undefined },
  ])("referrer manifest pushed by $label", ({ tag, pattern }) => {
    test("a failed manifest write leaves no link and no tag, and a retry completes", async () => {
      const digest = await sha256Digest(referrerManifest);
      const manifestKey = `repo/manifests/${digest}`;
      const linkKey = `repo/_referrers/${subjectDigest}/${digest}`;
      const tagKey = tag === undefined ? undefined : `repo/manifests/${tag}`;
      const { bucket, objects } = fakeBucket(new Set([manifestKey]));
      const env = { REGISTRY: bucket, IMMUTABLE_TAG_PATTERN: pattern } as Env;
      const push = () =>
        new R2Registry(env).putManifestInner(
          "repo",
          tag ?? digest,
          new Blob([referrerManifest]).stream(),
          imageManifestContentType,
          false,
        );

      await expect(push()).rejects.toThrow(/simulated R2 failure/);
      expect(objects.has(manifestKey)).toBe(false);
      expect(objects.has(linkKey)).toBe(false);
      if (tagKey !== undefined) expect(objects.has(tagKey)).toBe(false);

      const retried = await push();
      expect("response" in retried).toBe(false);
      expect(objects.has(manifestKey)).toBe(true);
      expect(objects.has(linkKey)).toBe(true);
      if (tagKey !== undefined) expect(objects.has(tagKey)).toBe(true);
    });

    test("a successful push writes the manifest, the link and the tag", async () => {
      const digest = await sha256Digest(referrerManifest);
      const { bucket, objects } = fakeBucket(new Set());
      const env = { REGISTRY: bucket, IMMUTABLE_TAG_PATTERN: pattern } as Env;
      const result = await new R2Registry(env).putManifestInner(
        "repo",
        tag ?? digest,
        new Blob([referrerManifest]).stream(),
        imageManifestContentType,
        false,
      );
      expect("response" in result).toBe(false);
      expect([...objects.keys()].sort()).toEqual(
        [
          `repo/manifests/${digest}`,
          `repo/_referrers/${subjectDigest}/${digest}`,
          ...(tag ? [`repo/manifests/${tag}`] : []),
        ].sort(),
      );
    });
  });
});

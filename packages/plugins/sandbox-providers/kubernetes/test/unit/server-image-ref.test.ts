import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAdapterDefaultsResolved } from "../../src/adapter-defaults.js";
import type { AdapterRegistryEntry } from "../../src/adapter-registry.js";
import {
  ECS_METADATA_URI_ENV,
  SERVER_IMAGE_REF_ENV,
  resetServerImageRefCache,
  resolveServerImageRef,
} from "../../src/server-image-ref.js";

const DIGEST = "a".repeat(64);
const REPO = "123456789012.dkr.ecr.us-east-1.amazonaws.com/paperclip-server";
const REF = `${REPO}@sha256:${DIGEST}`;
const META = "http://169.254.170.2/v4/abc";

function metadataFetch(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response);
}

const unsetEntry: AdapterRegistryEntry = {
  adapterType: "hermes_local",
  enabled: true,
  envKeys: [],
  allowFqdns: [],
  probeCommand: ["hermes", "--version"],
};

beforeEach(() => resetServerImageRefCache());

describe("resolveServerImageRef", () => {
  it("resolves from ECS metadata ImageID and caches the result", async () => {
    const fetchImpl = metadataFetch({ Image: `${REPO}:latest`, ImageID: REF });
    const env = { [ECS_METADATA_URI_ENV]: META };
    expect(await resolveServerImageRef({ env, fetchImpl })).toBe(REF);
    expect(await resolveServerImageRef({ env, fetchImpl })).toBe(REF);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe(META);
  });

  it("uses the explicit env override without touching metadata", async () => {
    const fetchImpl = metadataFetch({});
    const env = { [SERVER_IMAGE_REF_ENV]: REF, [ECS_METADATA_URI_ENV]: META };
    expect(await resolveServerImageRef({ env, fetchImpl })).toBe(REF);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails loudly when no source is available", async () => {
    await expect(resolveServerImageRef({ env: {} })).rejects.toThrow(
      /cannot determine the paperclip-server image/,
    );
  });

  it("rejects a malformed ImageID", async () => {
    const fetchImpl = metadataFetch({ ImageID: `${REPO}:latest` });
    await expect(
      resolveServerImageRef({ env: { [ECS_METADATA_URI_ENV]: META }, fetchImpl }),
    ).rejects.toThrow(/not a digest-pinned image reference/);
  });

  it("rejects missing ImageID and metadata HTTP errors, and does not cache failures", async () => {
    const env = { [ECS_METADATA_URI_ENV]: META };
    await expect(resolveServerImageRef({ env, fetchImpl: metadataFetch({}) })).rejects.toThrow(
      /no ImageID/,
    );
    await expect(
      resolveServerImageRef({ env, fetchImpl: metadataFetch({}, false) }),
    ).rejects.toThrow(/failed to read ECS task metadata/);
    expect(
      await resolveServerImageRef({ env, fetchImpl: metadataFetch({ ImageID: REF }) }),
    ).toBe(REF);
  });

  it("rejects a malformed explicit override", async () => {
    await expect(
      resolveServerImageRef({ env: { [SERVER_IMAGE_REF_ENV]: "repo:tag" } }),
    ).rejects.toThrow(/PAPERCLIP_SERVER_IMAGE_REF is not a digest-pinned/);
  });
});

describe("getAdapterDefaultsResolved", () => {
  it("fills an unset runtimeImage from the server image", async () => {
    const fetchImpl = metadataFetch({ ImageID: REF });
    const d = await getAdapterDefaultsResolved("hermes_local", [unsetEntry], {
      env: { [ECS_METADATA_URI_ENV]: META },
      fetchImpl,
    });
    expect(d.runtimeImage).toBe(REF);
    expect(d.probeCommand).toEqual(["hermes", "--version"]);
  });

  it("treats a blank runtimeImage as unset", async () => {
    const d = await getAdapterDefaultsResolved("hermes_local", [{ ...unsetEntry, runtimeImage: "  " }], {
      env: { [SERVER_IMAGE_REF_ENV]: REF },
    });
    expect(d.runtimeImage).toBe(REF);
  });

  it("uses an explicit pin unchanged and never resolves", async () => {
    const fetchImpl = metadataFetch({ ImageID: REF });
    const pin = "registry.example/pinned@sha256:" + "b".repeat(64);
    const d = await getAdapterDefaultsResolved("hermes_local", [{ ...unsetEntry, runtimeImage: pin }], {
      env: { [ECS_METADATA_URI_ENV]: META },
      fetchImpl,
    });
    expect(d.runtimeImage).toBe(pin);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a clear error (no fallback) when unset and the image cannot be determined", async () => {
    await expect(getAdapterDefaultsResolved("hermes_local", [unsetEntry], { env: {} })).rejects.toThrow(
      /hermes_local.*no runtimeImage.*could not be resolved/s,
    );
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  buildShareUrl,
  createShareLink,
  readShareIdFromLocation,
  resolveSharedCamera,
} from "../src/shareLinks";

describe("share links", () => {
  it("reads only GUID share ids from location", () => {
    expect(
      readShareIdFromLocation({
        href: "https://example.com/?share=f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
      })
    ).toBe("f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425");

    expect(
      readShareIdFromLocation({
        href: "https://example.com/?share=not-a-guid",
      })
    ).toBeNull();
  });

  it("builds share urls with only the share parameter", () => {
    const url = buildShareUrl("f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425", {
      href: "https://example.com/path?foo=bar#hash",
    });

    expect(url).toBe("https://example.com/path?share=f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425");
  });

  it("resolves shared camera payloads from API", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          x: 10,
          y: -20,
          zoom: 7,
        };
      },
    }));

    const camera = await resolveSharedCamera({
      apiBaseUrl: "https://api.example.com",
      shareId: "f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.example.com/share-links/f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
      {
        method: "GET",
      }
    );
    expect(camera).toMatchObject({
      x: 10,
      y: -20,
      cellPixelSize: 7,
    });
  });

  it("creates share links and copies resulting url", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          id: "f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
        };
      },
    }));
    const clipboard = {
      writeText: vi.fn(async () => {}),
    };

    const link = await createShareLink({
      apiBaseUrl: "https://api.example.com",
      camera: {
        x: 30,
        y: 40,
        cellPixelSize: 12,
      },
      locationLike: {
        href: "https://app.example.com/",
      },
      clipboard,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith("https://api.example.com/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        x: 30,
        y: 40,
        zoom: 12,
      }),
    });
    expect(clipboard.writeText).toHaveBeenCalledWith(
      "https://app.example.com/?share=f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425"
    );
    expect(link).toEqual({
      id: "f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
      url: "https://app.example.com/?share=f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
      copied: true,
      creatorUid: null,
    });
  });

  it("sends bearer token when creating share links", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      async json() {
        return {
          id: "f7d8a15e-14f6-4b3b-8d4a-ff8e51d4e425",
          creatorUid: "u_saved123",
        };
      },
    }));

    const link = await createShareLink({
      apiBaseUrl: "https://api.example.com",
      camera: {
        x: 0,
        y: 0,
        cellPixelSize: 12,
      },
      identityToken: "tok_abc",
      locationLike: {
        href: "https://app.example.com/",
      },
      clipboard: null,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledWith("https://api.example.com/share-links", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer tok_abc",
      },
      body: JSON.stringify({
        x: 0,
        y: 0,
        zoom: 12,
      }),
    });
    expect(link.creatorUid).toBe("u_saved123");
  });
});

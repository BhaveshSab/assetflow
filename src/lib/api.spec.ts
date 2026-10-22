import { afterEach, describe, expect, it, vi } from "vitest";

import { apiGet, apiSend, authHeaders, getToken, unwrapList } from "./api";

describe("api client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("authHeaders", () => {
    it("omits the Authorization header when nobody is signed in", () => {
      expect(authHeaders()).toEqual({ "Content-Type": "application/json" });
      expect(authHeaders().Authorization).toBeUndefined();
    });

    it("attaches the bearer token when one is stored", () => {
      localStorage.setItem("token", "abc123");
      expect(authHeaders().Authorization).toBe("Bearer abc123");
      expect(getToken()).toBe("abc123");
    });
  });

  describe("unwrapList", () => {
    it("unwraps { items } responses", () => {
      expect(unwrapList({ items: [1, 2, 3] })).toEqual([1, 2, 3]);
    });

    it("passes arrays through", () => {
      expect(unwrapList([1, 2])).toEqual([1, 2]);
    });

    it("returns an empty array for null/undefined", () => {
      expect(unwrapList(null)).toEqual([]);
      expect(unwrapList(undefined)).toEqual([]);
      expect(unwrapList({})).toEqual([]);
    });
  });

  describe("apiGet", () => {
    it("returns the parsed body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0 }),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await apiGet<{ items: unknown[]; total: number }>("/assets");
      expect(result.total).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/assets");
    });

    it("throws the API error message", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 409,
          json: async () => ({ message: "Asset is already held" }),
        }),
      );

      await expect(apiGet("/assets")).rejects.toThrow("Asset is already held");
    });

    it("uses the first message when the API returns a list", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          json: async () => ({ message: ["name must be longer", "other"] }),
        }),
      );

      await expect(apiGet("/assets")).rejects.toThrow("name must be longer");
    });

    it("explains an unreachable backend", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed")));

      await expect(apiGet("/assets")).rejects.toThrow(/Could not reach/);
    });
  });

  describe("apiSend", () => {
    it("serialises the body and sends the method", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "1" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await apiSend("/assets", "POST", { name: "Laptop" });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.method).toBe("POST");
      expect(init.body).toBe(JSON.stringify({ name: "Laptop" }));
    });

    it("does not send a body when none is given", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      await apiSend("/notifications/read-all", "POST");

      const [, init] = fetchMock.mock.calls[0];
      expect(init.body).toBeUndefined();
    });
  });
});

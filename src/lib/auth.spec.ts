import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiAuthConfig,
  apiGoogleSignIn,
  apiSignIn,
  apiSignUp,
  clearSession,
  getMe,
  getSession,
  saveSession,
} from "./auth";

const session = {
  token: "jwt-token",
  user: {
    id: "u1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    role: "ADMIN" as const,
    status: "ACTIVE",
    departmentId: null,
  },
};

describe("auth client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists and restores the session", () => {
    saveSession(session);
    expect(localStorage.getItem("token")).toBe("jwt-token");
    expect(getSession()).toEqual(session);
  });

  it("returns null when there is no (or broken) session", () => {
    expect(getSession()).toBeNull();
    localStorage.setItem("session", "{not json");
    expect(getSession()).toBeNull();
  });

  it("clears the session", () => {
    saveSession(session);
    clearSession();
    expect(localStorage.getItem("token")).toBeNull();
    expect(getSession()).toBeNull();
  });

  it("signs in and stores the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => session,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiSignIn({
      email: "ada@example.com",
      password: "password123",
    });

    expect(result.token).toBe("jwt-token");
    expect(getSession()?.user.email).toBe("ada@example.com");
    expect(fetchMock.mock.calls[0][1].body).toContain("ada@example.com");
  });

  it("surfaces the API error message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ message: "Invalid email or password" }),
      }),
    );

    await expect(
      apiSignIn({ email: "ada@example.com", password: "nope" }),
    ).rejects.toThrow("Invalid email or password");
  });

  it("loads the public sign-in configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        googleClientId: "client.apps.googleusercontent.com",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiAuthConfig()).resolves.toEqual({
      googleClientId: "client.apps.googleusercontent.com",
    });
    expect(fetchMock.mock.calls[0][0]).toContain("/auth/config");
  });

  it("exchanges a Google credential and stores the session", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => session,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiGoogleSignIn("google-id-token");

    expect(fetchMock.mock.calls[0][0]).toContain("/auth/google");
    expect(fetchMock.mock.calls[0][1].body).toContain("google-id-token");
    expect(result.token).toBe("jwt-token");
    expect(getSession()?.token).toBe("jwt-token");
  });

  it("signs up with a name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => session,
    });
    vi.stubGlobal("fetch", fetchMock);

    await apiSignUp({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "password123",
    });

    expect(fetchMock.mock.calls[0][0]).toContain("/auth/signup");
    expect(fetchMock.mock.calls[0][1].body).toContain("Ada Lovelace");
  });

  it("refreshes the current user", async () => {
    saveSession(session);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...session.user, role: "ASSET_MANAGER" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = await getMe();
    expect(user.role).toBe("ASSET_MANAGER");
    // The stored session is refreshed with the new role.
    expect(getSession()?.user.role).toBe("ASSET_MANAGER");
  });

  it("refuses to refresh without a token", async () => {
    await expect(getMe()).rejects.toThrow("Not signed in");
  });

  it("reports an expired session", async () => {
    saveSession(session);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );

    await expect(getMe()).rejects.toThrow("Session expired");
  });
});

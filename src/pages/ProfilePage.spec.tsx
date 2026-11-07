/**
 * /profile — the signed-in user's own account.
 *
 * The page reads the account, writes the name/picture, and changes the
 * password through the API. These tests pin the three calls down (method,
 * path and body), plus the client-side https rule the API also enforces.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveSession } from "@/lib/session";

import ProfilePage from "./ProfilePage";

const me = {
  id: "u1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  role: "EMPLOYEE" as const,
  status: "ACTIVE",
  departmentId: null,
  avatarUrl: null as string | null,
  credentialsChangedAt: null,
};

/** A fetch that answers each path with the given JSON. */
function fetchFor(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api/, "");
    const key = `${init?.method ?? "GET"} ${path}`;
    const body = routes[key];
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => body };
  });
}

function renderPage() {
  render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  );
}

describe("ProfilePage", () => {
  beforeEach(() => {
    saveSession({ token: "jwt-token", user: me });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the account and shows the role as read-only information", async () => {
    vi.stubGlobal("fetch", fetchFor({ "GET /auth/me": me }));

    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Ada Lovelace" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByText(/employee/i)).toBeInTheDocument();
  });

  it("saves a new name through PATCH /auth/me", async () => {
    const fetchMock = fetchFor({
      "GET /auth/me": me,
      "PATCH /auth/me": { ...me, name: "Ada King" },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const nameInput = await screen.findByLabelText(/^name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Ada King");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      /profile saved/i,
    );

    const patch = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({
      name: "Ada King",
      avatarUrl: null,
    });
  });

  it("refuses a non-https picture before sending anything", async () => {
    const fetchMock = fetchFor({ "GET /auth/me": me });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    const avatarInput = await screen.findByLabelText(/picture address/i);
    await userEvent.type(avatarInput, "javascript:alert(1)");
    await userEvent.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/https:\/\//i);
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("changes the password and says the other devices were signed out", async () => {
    const fetchMock = fetchFor({
      "GET /auth/me": me,
      "POST /auth/change-password": { token: "new-jwt" },
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(
      await screen.findByLabelText(/current password/i),
      "password123",
    );
    await userEvent.type(screen.getByLabelText(/^new password/i), "brand-new-passphrase");
    await userEvent.type(
      screen.getByLabelText(/confirm new password/i),
      "brand-new-passphrase",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /change password/i }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      /other device/i,
    );

    // The replacement token is stored, otherwise the next request would 401.
    await waitFor(() => {
      expect(localStorage.getItem("token")).toBe("new-jwt");
    });
  });

  it("keeps the two new passwords in step before calling the API", async () => {
    const fetchMock = fetchFor({ "GET /auth/me": me });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(
      await screen.findByLabelText(/current password/i),
      "password123",
    );
    await userEvent.type(screen.getByLabelText(/^new password/i), "brand-new-passphrase");
    await userEvent.type(
      screen.getByLabelText(/confirm new password/i),
      "something-else",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /change password/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
  });
});

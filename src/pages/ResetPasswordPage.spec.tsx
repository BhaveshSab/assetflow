/**
 * /reset-password — the page an e-mailed link opens.
 *
 * Covers the three states that matter: no token in the URL, a rejected token
 * (expired / used / forged all look the same), and success.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import ResetPasswordPage from "./ResetPasswordPage";

function renderPage(url = "/reset-password?token=token-abc-123") {
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/forgot-password" element={<p>forgot page</p>} />
        <Route path="/signin" element={<p>sign in page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ResetPasswordPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("explains a link that arrived without its token", () => {
    renderPage("/reset-password");
    expect(
      screen.getByRole("heading", { name: /link is incomplete/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /request a new link/i }),
    ).toHaveAttribute("href", "/forgot-password");
  });

  it("sends the token and the new password, then confirms", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "Your password has been changed." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(screen.getByLabelText(/^new password/i), "longpassword");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "longpassword");
    await userEvent.click(
      screen.getByRole("button", { name: /set new password/i }),
    );

    expect(
      await screen.findByRole("heading", { name: /password changed/i }),
    ).toBeInTheDocument();

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      token: "token-abc-123",
      password: "longpassword",
    });
  });

  it("refuses two different passwords before touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(screen.getByLabelText(/^new password/i), "longpassword");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "otherpassword");
    await userEvent.click(
      screen.getByRole("button", { name: /set new password/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/do not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces the same 8-character minimum as the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(screen.getByLabelText(/^new password/i), "1234567");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "1234567");
    await userEvent.click(
      screen.getByRole("button", { name: /set new password/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /at least 8 characters/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the token is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          message: "This reset link is invalid or has expired.",
        }),
      }),
    );

    renderPage();
    await userEvent.type(screen.getByLabelText(/^new password/i), "longpassword");
    await userEvent.type(screen.getByLabelText(/confirm password/i), "longpassword");
    await userEvent.click(
      screen.getByRole("button", { name: /set new password/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /invalid or has expired/i,
    );
  });
});

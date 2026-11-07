/**
 * /forgot-password, driven the way a person drives it.
 *
 * The one behaviour worth pinning down is that the screen gives the **same**
 * answer whether or not the address has an account: the API decides that, and
 * this page must not undo it with a different message.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import ForgotPasswordPage from "./ForgotPasswordPage";

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <Routes>
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/signin" element={<p>sign in page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ForgotPasswordPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks the API for a link and shows the neutral confirmation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ message: "If an account exists…" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(
      screen.getByLabelText(/email/i),
      "ada@example.com",
    );
    await userEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByText(/check your inbox/i)).toBeInTheDocument();
    // The same sentence for every address — no "no such account" here.
    expect(screen.getByRole("status")).toHaveTextContent(/ada@example\.com/);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/auth/forgot-password");
    expect(JSON.parse(init.body)).toEqual({ email: "ada@example.com" });
  });

  it("does not call the API for an address that cannot exist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    await userEvent.type(screen.getByLabelText(/email/i), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /valid email address/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a network failure without pretending a mail was sent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down")),
    );

    renderPage();
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: /send reset link/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/check your inbox/i)).not.toBeInTheDocument();
  });

  it("offers a way back to the sign-in page", () => {
    renderPage();
    expect(
      screen.getByRole("link", { name: /back to sign in/i }),
    ).toHaveAttribute("href", "/signin");
  });
});

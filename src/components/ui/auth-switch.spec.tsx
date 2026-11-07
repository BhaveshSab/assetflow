/**
 * The sign-in / sign-up card.
 *
 * Every assertion here is about a control that used to *look* functional and
 * was not: "Forgot password?" had no handler, the GitHub button was enabled
 * and did nothing, "Remember me" was wired to nothing, and the password rule
 * was laxer than the API's. Each one is now either real or gone, and this file
 * is what keeps it that way.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { AuthSwitch } from "./auth-switch";

function renderCard(
  props: Partial<React.ComponentProps<typeof AuthSwitch>> = {},
) {
  return render(
    <MemoryRouter>
      <AuthSwitch {...props} />
    </MemoryRouter>,
  );
}

describe("AuthSwitch", () => {
  it("links 'Forgot password?' to the page that actually resets it", () => {
    renderCard({ defaultMode: "signin" });

    const link = screen.getByRole("link", { name: /forgot password/i });
    expect(link).toHaveAttribute("href", "/forgot-password");
  });

  it("has no GitHub button, because the API has no GitHub sign-in", () => {
    renderCard({ defaultMode: "signin" });
    expect(screen.queryByRole("button", { name: /github/i })).toBeNull();
  });

  it("shows an honest, disabled Google button when Google is not configured", () => {
    renderCard({ defaultMode: "signin" });

    const google = screen.getByRole("button", { name: /google/i });
    expect(google).toBeDisabled();
    expect(google).toHaveAttribute(
      "title",
      "Google sign-in is not configured on this server",
    );
  });

  it("renders the real Google control when one is supplied", () => {
    renderCard({
      defaultMode: "signin",
      googleSlot: <button type="button">Continue with Google</button>,
    });
    expect(
      screen.getByRole("button", { name: /continue with google/i }),
    ).toBeEnabled();
  });

  it("keeps the server's 8-character password rule on the client", async () => {
    const onSubmit = vi.fn();
    renderCard({ defaultMode: "signin", onSubmit });

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    // Seven characters: the API would reject this, so the form must too.
    await userEvent.type(screen.getByLabelText(/^password/i), "1234567");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /at least 8 characters/i,
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits a valid sign-in through the real form", async () => {
    const onSubmit = vi.fn();
    renderCard({ defaultMode: "signin", onSubmit });

    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/^password/i), "password123");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(onSubmit).toHaveBeenCalledWith({
      mode: "signin",
      email: "ada@example.com",
      password: "password123",
      name: undefined,
    });
  });

  it("no longer offers 'Remember me' — the session length is the server's", () => {
    renderCard({ defaultMode: "signin" });
    expect(screen.queryByLabelText(/remember me/i)).toBeNull();
  });

  it("does not invent a testimonial or a free trial", () => {
    renderCard({ defaultMode: "signin" });
    expect(screen.queryByText(/alicia mercer/i)).toBeNull();
    expect(screen.queryByText(/free trial/i)).toBeNull();
    expect(screen.queryByText(/no credit card/i)).toBeNull();
  });

  it("points the footer switch at the other route when one is given", () => {
    renderCard({ defaultMode: "signin", otherTo: "/signup" });
    // Exact, case-sensitive: the purple panel's CTA ("Sign Up") is a separate
    // control, and this assertion is about the footer link.
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute(
      "href",
      "/signup",
    );
  });
});

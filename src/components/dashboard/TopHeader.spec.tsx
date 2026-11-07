import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import TopHeader, { initialsOf } from "./TopHeader";

describe("initialsOf", () => {
  it("uses the first letter of the first and last name", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
  });

  it("handles a single name", () => {
    expect(initialsOf("Ada")).toBe("A");
  });

  it("ignores extra whitespace", () => {
    expect(initialsOf("  Ada   Byron  ")).toBe("AB");
  });

  it("falls back to ? for an unknown name", () => {
    expect(initialsOf(undefined)).toBe("?");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf("   ")).toBe("?");
  });
});

describe("TopHeader avatar", () => {
  it("is a real link to the profile page, not a decoration", () => {
    // It used to be a div with `cursor-pointer` and a hover animation and no
    // behaviour: it looked like the way into your account and was not.
    render(
      <MemoryRouter>
        <TopHeader userName="Ada Lovelace" />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: /your profile/i });
    expect(link).toHaveAttribute("href", "/profile");
    expect(link).toHaveTextContent("AL");
  });

  it("shows the picture when the user has one", () => {
    render(
      <MemoryRouter>
        <TopHeader
          userName="Ada Lovelace"
          avatarUrl="https://images.example.com/ada.png"
        />
      </MemoryRouter>,
    );

    // `alt=""` on purpose: the link is already named "Your profile (Ada
    // Lovelace)", so the picture is decorative and must not be announced
    // twice.
    const link = screen.getByRole("link", { name: /your profile/i });
    const image = link.querySelector("img");
    expect(image).not.toBeNull();
    expect(image).toHaveAttribute("src", "https://images.example.com/ada.png");
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  });
});

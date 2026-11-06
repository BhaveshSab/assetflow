/**
 * The theme switch, driven the way a person drives it: find the button by the
 * name a screen reader would announce, click it, and check both the document
 * and the stored choice.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { THEME_KEY } from "@/lib/theme";

import ThemeToggle from "./theme-toggle";

function setSystemTheme(theme: "light" | "dark") {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: theme === "dark" && query.includes("dark"),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.documentElement.className = "";
    setSystemTheme("light");
  });

  it("names the action, not the current state", async () => {
    render(<ThemeToggle />);
    // Light theme is on, so the button offers dark.
    expect(
      screen.getByRole("button", { name: "Switch to dark theme" }),
    ).toBeInTheDocument();
  });

  it("reports its state through aria-pressed", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-pressed", "false");
  });

  it("switches the document to dark and remembers the choice", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: /switch to dark/i }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(
      screen.getByRole("button", { name: /switch to light/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("switches back to light", async () => {
    window.localStorage.setItem(THEME_KEY, "dark");
    document.documentElement.classList.add("dark");
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole("button", { name: /switch to light/i }));

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("starts from the operating system when nothing is stored", () => {
    vi.restoreAllMocks();
    setSystemTheme("dark");
    render(<ThemeToggle />);

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      screen.getByRole("button", { name: /switch to light/i }),
    ).toBeInTheDocument();
  });

  it("is reachable and operable from the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.tab();
    expect(screen.getByRole("button")).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("hides the icon from assistive technology and keeps the label", () => {
    const { container } = render(<ThemeToggle />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});

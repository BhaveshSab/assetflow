import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SearchDropdown } from "@/components/ui/search-dropdown";

const FRUITS = [
  { id: "a", name: "Apple" },
  { id: "b", name: "Banana" },
  { id: "c", name: "Cherry" },
];

function renderDropdown(overrides: Partial<React.ComponentProps<typeof SearchDropdown>> = {}) {
  const onSelect = vi.fn();
  const props = {
    label: "Select fruit",
    placeholder: "Pick one",
    icon: () => null,
    items: FRUITS,
    selected: null,
    onSelect,
    renderItem: (f: (typeof FRUITS)[number]) => f.name,
    renderSelected: (f: (typeof FRUITS)[number]) => f.name,
    filterFn: (f: (typeof FRUITS)[number], q: string) =>
      f.name.toLowerCase().includes(q.toLowerCase()),
    ...overrides,
  } as never;
  render(<SearchDropdown {...props} />);
  return { onSelect, user: userEvent.setup() };
}

describe("SearchDropdown — the combobox keyboard", () => {
  it("labels the trigger and says that it opens a list", async () => {
    const { user } = renderDropdown();

    const trigger = screen.getByRole("button", { name: /select fruit/i });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("exposes a combobox that controls the listbox", async () => {
    const { user } = renderDropdown();

    await user.click(screen.getByRole("button", { name: /select fruit/i }));

    const combo = screen.getByRole("combobox");
    expect(combo).toHaveAttribute("aria-expanded", "true");

    const list = screen.getByRole("listbox");
    expect(combo.getAttribute("aria-controls")).toBe(list.id);
    expect(within(list).getAllByRole("option")).toHaveLength(3);
  });

  it("moves the highlight with the arrow keys and selects with Enter", async () => {
    const { user, onSelect } = renderDropdown();

    await user.click(screen.getByRole("button", { name: /select fruit/i }));
    const combo = screen.getByRole("combobox");

    // The first option is highlighted as soon as the list opens.
    const list = screen.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(combo.getAttribute("aria-activedescendant")).toBe(options[1].id);

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(FRUITS[1]);
  });

  it("wraps around at the top and the bottom", async () => {
    const { user } = renderDropdown();

    await user.click(screen.getByRole("button", { name: /select fruit/i }));
    await user.keyboard("{ArrowUp}");

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
  });

  it("closes on Escape and gives the focus back to the trigger", async () => {
    const { user } = renderDropdown();
    const trigger = screen.getByRole("button", { name: /select fruit/i });

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The list leaves the page once the exit animation has played out.
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("filters as you type and announces how many results are left", async () => {
    const { user } = renderDropdown();

    await user.click(screen.getByRole("button", { name: /select fruit/i }));
    await user.keyboard("ban");

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Banana");
    expect(screen.getByRole("status")).toHaveTextContent("1 result");
  });

  it("opens with the keyboard alone", async () => {
    const { user } = renderDropdown();
    const trigger = screen.getByRole("button", { name: /select fruit/i });

    trigger.focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveFocus();
  });
});

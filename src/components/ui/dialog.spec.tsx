/**
 * The accessible dialog — the accessibility contract, proven by tests.
 *
 * These are the behaviours that the plain `<div>` overlays did not have:
 * a role and an accessible name, a focus trap, Escape, and a focus restore.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog, Dialog } from "./dialog";

describe("Dialog", () => {
  it("is announced as a dialog with a name", async () => {
    render(
      <Dialog open onClose={() => {}} title="Register an asset" description="Add a new asset to the inventory.">
        <button type="button">Save</button>
      </Dialog>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Register an asset" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The description is announced together with the title.
    expect(dialog).toHaveAccessibleDescription("Add a new asset to the inventory.");
  });

  it("moves the focus into the dialog when it opens", async () => {
    render(
      <Dialog open onClose={() => {}} title="Register an asset">
        <button type="button">Save</button>
      </Dialog>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    });
  });

  it("keeps the Tab key inside the dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open onClose={() => {}} title="Register an asset">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Dialog>,
    );

    const first = await screen.findByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });

    await waitFor(() => expect(first).toHaveFocus());
    await user.tab();
    expect(last).toHaveFocus();

    // Tab on the last element wraps back to the first one — the focus can
    // never escape into the page behind the dialog.
    await user.tab();
    expect(first).toHaveFocus();

    // …and backwards, too.
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Register an asset">
        <button type="button">Save</button>
      </Dialog>,
    );

    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Register an asset">
        <button type="button">Save</button>
      </Dialog>,
    );

    await user.click(screen.getByTestId("dialog-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns the focus to the element that opened it", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Register an asset">
            <button type="button">Save</button>
          </Dialog>
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await screen.findByRole("dialog");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it("stops the page behind from scrolling", async () => {
    render(
      <Dialog open onClose={() => {}} title="Register an asset">
        <button type="button">Save</button>
      </Dialog>,
    );

    await screen.findByRole("dialog");
    expect(document.body.style.overflow).toBe("hidden");
  });
});

describe("ConfirmDialog", () => {
  it("asks before a destructive action and reports the answer", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <ConfirmDialog
        open
        destructive
        title="Reject this transfer?"
        message="The requester will be notified."
        confirmLabel="Reject"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Reject this transfer?" });
    expect(dialog).toHaveAccessibleDescription("The requester will be notified.");

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

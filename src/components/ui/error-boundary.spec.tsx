import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "@/components/ui/error-boundary";

function Boom({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("The chart could not be drawn");
  return <p>Everything is fine</p>;
}

describe("ErrorBoundary", () => {
  beforeEach(() => {
    // React logs the caught error — that is expected here.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows a friendly panel instead of a blank page", () => {
    render(
      <ErrorBoundary area="chart">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The chart could not be shown");
    expect(alert).toHaveTextContent("The chart could not be drawn");
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("renders the children while nothing is broken", () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Everything is fine")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lets the user try again without a reload", async () => {
    const user = userEvent.setup();
    let broken = true;

    function Flaky() {
      if (broken) throw new Error("Temporary failure");
      return <p>Recovered</p>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    broken = false;
    await user.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("Recovered")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

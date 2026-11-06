/**
 * A labelled form field.
 *
 * The label used to be a `<label>` **without** `htmlFor`, so it was not
 * associated with the input:
 *   * a screen reader read the label and the field as two unrelated things,
 *   * clicking the label did not move the focus to the field,
 *   * the error message was not announced and not linked to the field.
 *
 * This component fixes all three (WCAG 1.3.1, 3.3.1, 3.3.2, 4.1.2, 4.1.3):
 * the label points at the control, the control is marked invalid when it has
 * an error, the error is referenced by `aria-describedby` and announced with
 * `role="alert"`.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

export interface FieldProps {
  /** The visible label. */
  label: string;
  /** The control. An input/select/textarea is wired up automatically. */
  children: React.ReactNode;
  /** Is the field mandatory? */
  required?: boolean;
  /** The validation error, if there is one. */
  error?: string;
  /** A hint under the control. */
  hint?: string;
  /** The id of the control — generated when it is not given. */
  htmlFor?: string;
  className?: string;
  /** The label classes (the dark theme). */
  labelClassName?: string;
}

export function Field({
  label,
  children,
  required = false,
  error,
  hint,
  htmlFor,
  className,
  labelClassName,
}: FieldProps) {
  const generatedId = React.useId();
  const fieldId = htmlFor ?? generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  // Only a real form control can take the id/aria attributes. A custom
  // widget (a button that opens a dropdown, for example) keeps its own
  // semantics and is labelled by the consumer.
  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        id: fieldId,
        "aria-invalid": error ? true : undefined,
        "aria-describedby":
          [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") ||
          undefined,
        "aria-required": required || undefined,
        required: required || undefined,
      })
    : children;

  return (
    <div className={cn("w-full", className)}>
      <label
        htmlFor={fieldId}
        className={cn(
          "block text-xs font-semibold text-ink-muted mb-1.5 uppercase tracking-wide",
          labelClassName,
        )}
      >
        {label}{" "}
        {required && (
          <span className="text-danger normal-case" aria-hidden="true">
            *
          </span>
        )}
        {required && <span className="sr-only"> (required)</span>}
      </label>

      {child}

      {hint && !error && (
        <p id={hintId} className="text-ink-subtle text-[11px] mt-1.5">
          {hint}
        </p>
      )}

      {error && (
        <p
          id={errorId}
          role="alert"
          className="text-danger text-[11px] mt-1.5 flex items-center gap-1"
        >
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}
    </div>
  );
}

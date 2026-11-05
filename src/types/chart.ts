/**
 * The shape Recharts hands to a custom tooltip.
 *
 * The tooltips used to be typed as `any`, which meant a typo in a chart
 * (a renamed field, a missing colour) was found by the browser, not by the
 * compiler.
 */
export interface ChartTooltipEntry {
  name?: React.ReactNode;
  value?: React.ReactNode;
  color?: string;
  fill?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: React.ReactNode;
}

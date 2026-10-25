const DATE_STEP_PATH = "M627.626667 542.293333l-128 128c-8.533333 8.106667-19.2 12.373333-30.293334 12.373334-11.093333 0-21.76-4.266667-30.293333-12.373334-16.64-16.64-16.64-43.946667 0-60.586666l98.133333-97.706667-98.133333-97.706667c-16.64-16.64-16.64-43.946667 0-60.586666 16.64-16.64 43.946667-16.64 60.586667 0l128 128c16.64 16.64 16.64 43.946667 0 60.586666z";

export function DateStepGlyph({ direction }: { readonly direction: "left" | "right" }) {
  // Keep the source proportions and mirrored optical correction in fixed SVG
  // units, independent of the responsive button's frame dimensions.
  const left = direction === "left";
  const transform = `translate(${left ? -.7 : .7} 0) scale(${left ? -.0645 : .0645} 0.0645) translate(-533.333333 -512)`;
  return <svg className="material-date-arrow" viewBox="0 0 38 48" width="38" height="48" aria-hidden="true" focusable="false">
    <g transform="translate(19 24)"><path fill="currentColor" transform={transform} d={DATE_STEP_PATH} /></g>
  </svg>;
}

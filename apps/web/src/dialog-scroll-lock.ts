let locks = 0;
let previousOverflow = "";

/** Nested readers may close together or in either order. */
export function lockDialogScroll(): () => void {
  if (locks++ === 0) previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--locks === 0) document.body.style.overflow = previousOverflow;
  };
}

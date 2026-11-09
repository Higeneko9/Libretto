import type { MouseEvent } from "react";

let pressedOnBackdrop = false;

// A text-selection drag that starts inside a dialog and ends on the backdrop still fires `click` on the
// backdrop, so only close when the press began on the backdrop too.
export function backdropClose(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent) => {
      pressedOnBackdrop = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent) => {
      const close = pressedOnBackdrop && e.target === e.currentTarget;
      pressedOnBackdrop = false;
      if (close) onClose();
    },
  };
}

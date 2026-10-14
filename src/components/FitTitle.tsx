import { memo, useLayoutEffect, useRef } from 'react';

const MAX_FONT_PX = 30;
// Smallest size that still reads from arm's length; below this the title is cut off with "…"
const MIN_FONT_PX = 13;
const LINE_HEIGHT = 1.15;

interface FitTitleProps {
  text: string;
  className?: string;
}

// A tile title that wraps onto more lines first, then shrinks until all of it fits its box.
// Sizing is done directly on the element and only reruns when the text or the box size
// changes, so the grid redrawing while audio plays doesn't refit anything.
function FitTitle({ text, className }: FitTitleProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = textRef.current;
    if (!box || !inner) return;

    const fits = (px: number) => {
      inner.style.fontSize = `${px}px`;
      return inner.scrollHeight <= box.clientHeight + 1 && inner.scrollWidth <= box.clientWidth + 1;
    };

    const fit = () => {
      if (box.clientWidth === 0 || box.clientHeight === 0) return;
      // Measure unclamped, with whole words kept together
      inner.style.display = 'block';
      inner.style.webkitLineClamp = '';
      inner.style.overflowWrap = 'normal';
      inner.removeAttribute('title');

      const search = () => {
        if (fits(MAX_FONT_PX)) return MAX_FONT_PX;
        let best = MIN_FONT_PX;
        let lo = MIN_FONT_PX;
        let hi = MAX_FONT_PX - 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (fits(mid)) {
            best = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        return best;
      };

      let best = search();
      if (fits(best)) return;

      // A single long word: allow breaking inside words and try again
      inner.style.overflowWrap = 'anywhere';
      best = search();
      if (fits(best)) return;

      // Still too long at the smallest size: cut off with "…"
      inner.style.display = '-webkit-box';
      inner.style.webkitBoxOrient = 'vertical';
      inner.style.webkitLineClamp = String(Math.max(1, Math.floor(box.clientHeight / (best * LINE_HEIGHT))));
      inner.setAttribute('title', text);
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div
      ref={boxRef}
      className="absolute left-2 right-2 top-10 bottom-9 flex items-center justify-center z-10 pointer-events-none overflow-hidden"
    >
      <div
        ref={textRef}
        className={`w-full font-bold text-center overflow-hidden ${className ?? ''}`}
        style={{ fontSize: `${MAX_FONT_PX}px`, lineHeight: LINE_HEIGHT }}
      >
        {text}
      </div>
    </div>
  );
}

export default memo(FitTitle);

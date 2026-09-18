import { useLayoutEffect, useState, type RefObject } from "react";

export function useOverviewSize(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (width > 0)
        setSize((previous) =>
          Math.abs(previous.width - width) < 1 &&
          Math.abs(previous.height - height) < 1
            ? previous
            : { width, height },
        );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return size;
}

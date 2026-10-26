import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export function useFirePicker<T>(
  items: T[],
  onSelect: (item: T) => void,
  anchor: "button" | "parent",
) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const chosenIndex = Math.min(active, Math.max(items.length - 1, 0));

  function updatePosition() {
    const element = anchor === "parent" ? trigger.current?.parentElement : trigger.current;
    const bounds = element?.getBoundingClientRect();
    if (bounds) setPosition({ left: bounds.left, top: bounds.bottom + 6, width: bounds.width });
  }

  function openPicker() {
    updatePosition();
    setActive(0);
    setOpen(true);
  }

  function closePicker() {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }

  function choose(item: T) {
    onSelect(item);
    closePicker();
  }

  useEffect(() => {
    if (!open) return;
    searchField.current?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !trigger.current?.contains(target)) closePicker();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", updatePosition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, items.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    }
    if (event.key === "Enter" && items[chosenIndex]) {
      event.preventDefault();
      choose(items[chosenIndex]);
    }
  }

  function onDialogKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") closePicker();
    if (event.key !== "Tab") return;
    const controls = popover.current?.querySelectorAll<HTMLElement>("input, select, button");
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return {
    open,
    active,
    setActive,
    position,
    trigger,
    searchField,
    popover,
    chosenIndex,
    openPicker,
    closePicker,
    choose,
    onSearchKey,
    onDialogKey,
  };
}

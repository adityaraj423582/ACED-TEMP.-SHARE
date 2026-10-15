/**
 * An in-page dropdown that replaces the native <select>.
 *
 * Windows content protection (WDA_EXCLUDEFROMCAPTURE) is applied per WINDOW HANDLE,
 * and the overlay only owns one. A native <select> popup is rendered by the OS as a
 * SEPARATE top-level window with its own handle, so it is NOT covered — open a
 * provider list mid-meeting and the option list is visible to Meet/Zoom/Teams even
 * though the overlay itself is not. Same trap as native tooltips and context menus.
 *
 * This renders the list as ordinary DOM inside the protected window, so it inherits
 * the exclusion (and the privacy dim) like everything else.
 */

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface Dropdown {
  /** Replaces the option list, keeping the current value if it still exists. */
  setOptions: (options: DropdownOption[]) => void;
  getValue: () => string;
  setValue: (value: string) => void;
  setDisabled: (disabled: boolean) => void;
  /** Fires only on a real user choice, never on setValue(). */
  onChange: (handler: (value: string) => void) => void;
}

/** Every open dropdown, so opening one closes the others. */
const openDropdowns = new Set<() => void>();

export function createDropdown(root: HTMLElement): Dropdown {
  let options: DropdownOption[] = [];
  let value = "";
  let disabled = false;
  let handler: ((value: string) => void) | null = null;

  root.classList.add("dd");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dd-btn";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");

  const list = document.createElement("div");
  list.className = "dd-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;

  root.replaceChildren(button, list);

  const labelFor = (v: string): string => options.find((o) => o.value === v)?.label ?? v;

  const render = (): void => {
    button.textContent = labelFor(value);
    list.replaceChildren(
      ...options.map((option) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "dd-item";
        item.textContent = option.label;
        item.dataset.value = option.value;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(option.value === value));
        if (option.disabled) item.disabled = true;
        item.addEventListener("click", () => {
          if (option.disabled) return;
          close();
          if (option.value === value) return;
          value = option.value;
          render();
          handler?.(value);
        });
        return item;
      }),
    );
  };

  function close(): void {
    if (list.hidden) return;
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    openDropdowns.delete(close);
  }

  const open = (): void => {
    if (disabled) return;
    for (const closeOther of [...openDropdowns]) closeOther();
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    openDropdowns.add(close);
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (list.hidden) open();
    else close();
  });
  // Click anywhere else, or press Escape, to dismiss.
  document.addEventListener("click", () => close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  render();

  return {
    setOptions: (next) => {
      options = next;
      if (!options.some((o) => o.value === value)) {
        value = options.find((o) => !o.disabled)?.value ?? options[0]?.value ?? "";
      }
      render();
    },
    getValue: () => value,
    setValue: (next) => {
      value = next;
      render();
    },
    setDisabled: (next) => {
      disabled = next;
      button.disabled = next;
      if (next) close();
    },
    onChange: (next) => {
      handler = next;
    },
  };
}

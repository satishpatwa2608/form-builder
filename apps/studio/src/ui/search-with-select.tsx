"use client";
/* eslint-disable @typescript-eslint/no-unused-vars */

import * as React from "react";
import * as ReactDOM from "react-dom";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "./utils";

export interface SearchWithSelectProps<T> {
  items: T[];
  value?: string;
  onChange: any;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  placement?: "auto" | "top" | "bottom";
  /**
   * Unique key for each item (also used as the value emitted in onChange).
   */
  getKey: any;
  /**
   * Label shown in the input and list.
   */
  getLabel: any;
  /**
   * Fields to search over for a given item. Defaults to just getLabel(item).
   */
  getSearchFields?: any;
  emptyText?: string;
}

export function SearchWithSelect<T>({
  items,
  value,
  onChange,
  placeholder = "Select...",
  className,
  disabled = false,
  placement = "auto",
  getKey,
  getLabel,
  getSearchFields,
  emptyText = "No results found",
}: SearchWithSelectProps<T>) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dropdownPosition, setDropdownPosition] = React.useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 200,
    placement: "bottom" as "top" | "bottom",
  });

  const updateDropdownPosition = React.useCallback(() => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

    // If the trigger field has scrolled out of the visible viewport (fully above or
    // below), there's no sane position to anchor to — close instead of letting the
    // dropdown float disconnected from its field (e.g. drifting up into the header).
    if (rect.bottom < 0 || rect.top > viewportHeight) {
      setIsOpen(false);
      return;
    }

    const margin = 8;
    const gap = 4;
    const preferredMinHeight = 120;
    const preferredMaxHeight = 220;

    const safeWidth = Math.min(rect.width, Math.max(140, viewportWidth - margin * 2));
    const safeLeft = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, viewportWidth - safeWidth - margin)
    );

    const spaceBelow = viewportHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;

    let shouldOpenAbove = false;

    if (placement === "top") {
      shouldOpenAbove = spaceAbove > 0 || spaceAbove >= spaceBelow;
    } else if (placement === "bottom") {
      shouldOpenAbove = false;
    } else {
      // Prefer opening below when there is enough room; otherwise open on the side with more room.
      shouldOpenAbove =
        spaceBelow < preferredMinHeight
          ? spaceAbove >= spaceBelow
          : false;
    }

    const availableHeight = shouldOpenAbove ? spaceAbove : spaceBelow;
    // Keep dropdown fully within viewport by never exceeding available space.
    const maxHeight = Math.max(0, Math.min(preferredMaxHeight, availableHeight));
    const top = shouldOpenAbove
      ? Math.max(margin, rect.top - gap)
      : Math.max(margin, rect.bottom + gap);

    // Dropdown uses `position: fixed`, so use viewport coordinates directly.
    setDropdownPosition({
      top,
      left: safeLeft,
      width: safeWidth,
      maxHeight,
      placement: shouldOpenAbove ? "top" : "bottom",
    });
  }, [placement]);

  const selectedItem = React.useMemo(
    () => items.find((item) => getKey(item) === value),
    [items, value, getKey]
  );

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredItems = React.useMemo(() => {
    if (!normalizedSearch) return items;

    return items.filter((item) => {
      const fields = (getSearchFields?.(item) ?? [getLabel(item)]).filter(Boolean) as string[];
      return fields.some((field: string) =>
        field.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [items, normalizedSearch, getLabel, getSearchFields]);

  React.useEffect(() => {
    if (!isOpen) return;

    updateDropdownPosition();

    const onViewportChange = () => {
      updateDropdownPosition();
    };

    // Capture scroll from any ancestor container so dropdown stays anchored.
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);

    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", onViewportChange);
      window.visualViewport.addEventListener("scroll", onViewportChange);
    }

    return () => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);

      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", onViewportChange);
        window.visualViewport.removeEventListener("scroll", onViewportChange);
      }
    };
  }, [isOpen, updateDropdownPosition]);

  React.useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node) &&
          inputRef.current && !inputRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  React.useEffect(() => {
    if (!disabled) return;
    setIsOpen(false);
    setSearchQuery("");
  }, [disabled]);

  const displayValue = isOpen
    ? searchQuery
    : selectedItem
    ? getLabel(selectedItem)
    : "";

  const dropdown = isOpen ? (
    <div 
      ref={dropdownRef}
      style={{
        position: 'fixed',
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
        width: `${dropdownPosition.width}px`,
        maxHeight: `${dropdownPosition.maxHeight}px`,
        transform: dropdownPosition.placement === 'top' ? 'translateY(-100%)' : 'none',
        zIndex: 9999,
        overflowY: 'auto',
        pointerEvents: 'auto',
      }} 
      className="bg-white border rounded-md shadow-lg"
      onMouseDown={(e) => {
        // Prevent the mousedown from triggering the outside click handler
        e.stopPropagation();
      }}
      onWheel={(e) => {
        // Allow wheel scrolling and stop propagation to prevent parent scroll
        e.stopPropagation();
      }}
    >
      {filteredItems.length > 0 ? (
        filteredItems.map((item) => {
          const key = getKey(item);
          return (
            <button
              key={key}
              type="button"
              onMouseDown={(e) => {
                // Prevent default and stop propagation to avoid any conflicts
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange(key, item);
                setIsOpen(false);
                setSearchQuery("");
              }}
              className={cn(
                "w-full text-left px-3 py-2 text-xs hover:bg-gray-100 cursor-pointer",
                value === key && "bg-blue-50 text-blue-600 font-medium"
              )}
            >
              {getLabel(item)}
            </button>
          );
        })
      ) : (
        <div className="px-3 py-2 text-xs text-gray-400 text-center">
          {emptyText}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div className={cn("relative w-full", className)}>
      {/* Main Input / Trigger */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={isOpen ? searchQuery : ""}
          disabled={disabled}
          onChange={(e) => {
            if (disabled) return;
            const next = e.target.value;
            setSearchQuery(next);
            if (!isOpen) setIsOpen(true);
          }}
          onFocus={() => {
            if (!disabled) setIsOpen(true);
          }}
          placeholder={!isOpen && selectedItem ? "" : placeholder}
          className={cn(
            "w-full border rounded-md px-3 py-2 pr-14 text-xs bg-white outline-none focus:outline-none active:outline-none",
            disabled && "cursor-not-allowed bg-gray-50 text-gray-500"
          )}
        />
        {/* Selected value display — rendered as a div so truncate works reliably */}
        {!isOpen && selectedItem && (
          <div
            className="absolute inset-0 flex items-center pointer-events-none"
            style={{ paddingLeft: '12px', paddingRight: '56px' }}
          >
            <span
              className="text-xs"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                flex: 1,
              }}
            >
              {getLabel(selectedItem)}
            </span>
          </div>
        )}
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {value && !disabled && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange("", null);
                setSearchQuery("");
              }}
              className="p-0 hover:bg-transparent pointer-events-auto"
            >
              <X className="h-4 w-4 text-gray-400 hover:text-gray-600" />
            </button>
          )}
          {isOpen && <Search className="w-4 h-4 text-gray-400" />}
          <button
            type="button"
            disabled={disabled}
            onMouseDown={(e) => {
              // Prevent input blur before click toggles state
              e.preventDefault();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsOpen((prev) => !prev);
              if (!isOpen) {
                inputRef.current?.focus();
              }
            }}
            className="p-0 hover:bg-transparent pointer-events-auto"
            aria-label={isOpen ? "Close options" : "Open options"}
          >
            <ChevronDown
              className={cn(
                "w-4 h-4 text-gray-400 transition-transform",
                isOpen && "rotate-180"
              )}
            />
          </button>
        </div>
      </div>

      {/* Portal the dropdown to document body */}
      {typeof document !== 'undefined' && ReactDOM.createPortal(dropdown, document.body)}
    </div>
  );
}

export default SearchWithSelect;

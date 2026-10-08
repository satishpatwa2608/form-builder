"use client";

import * as React from "react";
import { CheckIcon, X } from "lucide-react";
import { cn } from "./utils";

interface MultiSelectOption {
  value: string;
  label?: string;
  searchText?: string;
  renderLabel?: () => React.ReactNode;
  renderSelectedLabel?: () => React.ReactNode;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  dropdownMaxHeight?: number;
  maxVisibleTags?: number;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Search...",
  disabled,
  className,
  dropdownMaxHeight = 192,
  maxVisibleTags = 2,
}: MultiSelectProps) {
  const [searchText, setSearchText] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);
  const [filteredOptions, setFilteredOptions] = React.useState<MultiSelectOption[]>([]);
  const [showAbove, setShowAbove] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Determine if dropdown should show above or below
  React.useEffect(() => {
    if (isFocused && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      
      // If not enough space below but more space above, show above
      if (spaceBelow < dropdownMaxHeight && spaceAbove > spaceBelow) {
        setShowAbove(true);
      } else {
        setShowAbove(false);
      }
    }
  }, [isFocused, dropdownMaxHeight]);

  // Scroll into view when dropdown opens
  React.useEffect(() => {
    if (isFocused && inputRef.current) {
      setTimeout(() => {
        inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [isFocused]);

  // Filter options based on search text
  React.useEffect(() => {
    if (searchText.length > 0) {
      const search = searchText.toLowerCase();
      setFilteredOptions(
        options
          .sort((a, b) => (a.label || a.value).localeCompare(b.label || b.value))
          .filter((opt) => {
            const targetText = `${opt.label || opt.value} ${opt.searchText || ""}`.toLowerCase();
            return targetText.includes(search);
          })
      );
    } else if (isFocused && searchText.length === 0) {
      // Show all options when clicking on empty field
      setFilteredOptions(options.sort((a, b) => (a.label || a.value).localeCompare(b.label || b.value)));
    } else {
      setFilteredOptions([]);
    }
  }, [isFocused, searchText, options]);

  const onTextChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchText(e.target.value);
  };

  const toggleValue = (optValue: string) => {
    if (value.includes(optValue)) {
      onChange(value.filter(v => v !== optValue));
    } else {
      onChange([...value, optValue]);
    }
    // Clear search text after selection
    setSearchText("");
  };

  const clearAll = () => {
    onChange([]);
    setSearchText("");
    setFilteredOptions([]);
  };

  const handleBlur = () => {
    setTimeout(() => {
      setIsFocused(false);
      setSearchText("");
    }, 200);
  };

  const getSelectedLabels = () => {
    return value.map(v => {
      const opt = options.find(o => o.value === v);
      return { 
        value: v, 
        label: opt?.label || opt?.value || v,
        renderSelectedLabel: opt?.renderSelectedLabel
      };
    });
  };

  const selectedLabels = getSelectedLabels();
  const visibleSelectedLabels = selectedLabels.slice(0, Math.max(0, maxVisibleTags));
  const hiddenSelectedCount = Math.max(0, selectedLabels.length - visibleSelectedLabels.length);

  const removeValue = (optValue: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onChange(value.filter(v => v !== optValue));
  };

  return (
    <div className="relative w-full" ref={containerRef}>
      <div 
        className={cn(
          "border rounded-md px-2 py-1.5 text-sm w-full bg-white min-h-[38px] cursor-text flex flex-wrap gap-1 items-center",
          className
        )}
        onClick={() => {
          if (!disabled) {
            inputRef.current?.focus();
            setIsFocused(true);
          }
        }}
      >
        {value.length > 0 && visibleSelectedLabels.map((item) => (
          <span
            key={item.value}
            className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-xs font-medium"
          >
            {item.renderSelectedLabel ? (
              item.renderSelectedLabel()
            ) : (
              <span className="max-w-[150px] truncate">{item.label}</span>
            )}
            <button
              type="button"
              onClick={(e) => removeValue(item.value, e)}
              className="hover:bg-blue-200 rounded-full p-0.5 cursor-pointer"
              disabled={disabled}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {hiddenSelectedCount > 0 && (
          <span className="inline-flex items-center bg-slate-100 text-slate-700 px-2 py-0.5 rounded text-xs font-medium">
            +{hiddenSelectedCount} more
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          value={searchText}
          onChange={onTextChange}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] outline-none bg-transparent text-sm"
          onFocus={() => setIsFocused(true)}
          onBlur={handleBlur}
          disabled={disabled}
        />
      </div>

      {isFocused && (
        <ul
          className={cn(
            "absolute left-0 right-0 bg-white border rounded-md shadow-lg overflow-y-auto",
            showAbove ? "bottom-full mb-1" : "mt-1"
          )}
          style={{ maxHeight: `${dropdownMaxHeight}px`, zIndex: 9999 }}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent blur event when clicking scrollbar
          }}
        >
          {filteredOptions.length > 0 ? (
            filteredOptions.map((opt) => {
              const isSelected = value.includes(opt.value);
              return (
                <li
                  key={opt.value}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur event
                    toggleValue(opt.value);
                  }}
                  className={cn(
                    "px-3 py-2 cursor-pointer flex items-center gap-2 text-sm",
                    isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <span className={cn("size-4 inline-flex items-center justify-center", isSelected ? "text-accent-foreground" : "text-muted-foreground")}>
                    {isSelected && <CheckIcon className="size-4" />}
                  </span>
                  <div className="flex-1">
                    {opt.renderLabel ? opt.renderLabel() : <span className="line-clamp-1">{opt.label || opt.value}</span>}
                  </div>
                </li>
              );
            })
          ) : (
            <li className="px-3 py-2 text-gray-400 text-center text-sm">
              No options found
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export default MultiSelect;


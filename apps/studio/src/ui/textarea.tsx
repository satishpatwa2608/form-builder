import * as React from "react";

import { cn } from "./utils";

function Textarea({ className, rows, ...props }: React.ComponentProps<"textarea">) {
  const hasExplicitRows = rows !== undefined;

  return (
    <textarea
      data-slot="textarea"
      rows={rows}
      className={cn(
        "resize-none border-input placeholder:text-muted-foreground dark:bg-input/30 flex w-full rounded-md border bg-input-background px-3 py-2 text-sm font-normal transition-all outline-none focus-visible:ring-3 ring-ring/50 focus-visible:ring-offset-2 focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        !hasExplicitRows && "field-sizing-content min-h-16",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };

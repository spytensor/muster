import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `type="password"` here is always a key or a token typed by an administrator, never a
 * person's password (people sign in at their company's own page). A real password field
 * invites the browser to put the saved sign-in into it, and the person's address into the
 * field before it: the owner found their e-mail in "Workspace" and a password in "API
 * key" (2026-11-24). So it is a text field whose letters are drawn as dots, which no
 * browser or password manager takes for a sign-in.
 */
function Input({ className, type, style, ...props }: React.ComponentProps<"input">) {
  const secret = type === "password";
  return (
    <input
      type={secret ? "text" : type}
      {...(secret
        ? {
            autoComplete: "off",
            autoCorrect: "off",
            autoCapitalize: "off",
            spellCheck: false,
            "data-1p-ignore": true,
            "data-lpignore": "true",
            "data-bwignore": true,
            "data-form-type": "other",
          }
        : {})}
      style={secret ? ({ ...style, WebkitTextSecurity: "disc" } as React.CSSProperties) : style}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground disabled:opacity-50 md:text-sm dense:h-7 dense:px-2.5 dense:md:text-[13px]",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-16 w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-9 w-full rounded-lg border border-input bg-transparent px-3 text-base shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 md:text-sm dense:h-7 dense:px-2 dense:md:text-[13px]",
        className,
      )}
      {...props}
    />
  );
}
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or wrap the control
    <label
      data-slot="label"
      className={cn("grid gap-2 text-sm font-medium select-none", className)}
      {...props}
    />
  );
}
export { Input, Textarea, NativeSelect, Label };

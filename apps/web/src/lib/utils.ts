import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * A person's address as it is shown. Someone who came from the company's directory
 * without one is kept under an address nobody can write to (".invalid", made up by the
 * server): that is never shown as theirs.
 */
export const address = (email: string | null | undefined): string =>
  !email || email.endsWith(".invalid") ? "" : email;

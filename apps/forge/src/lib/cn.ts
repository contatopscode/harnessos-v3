import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** `cn(...)` — shadcn-style class merger (clsx + tailwind-merge). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

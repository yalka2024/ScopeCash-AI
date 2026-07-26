import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// shadcn className helper: merge conditional classes, de-duping Tailwind utilities.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}


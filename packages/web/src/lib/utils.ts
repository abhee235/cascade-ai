import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes with conflict resolution (the shadcn `cn` helper). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** "just now" / "18h ago" / "3d ago" — compact relative time. */
export function relativeTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m ago`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h ago`
  const d = h / 24
  if (d < 30) return `${Math.floor(d)}d ago`
  if (d < 365) return `${Math.floor(d / 30)}mo ago`
  return `${Math.floor(d / 365)}y ago`
}

/** A deterministic, pleasant gradient + solid color from a string (for project thumbnails/avatars). */
export function colorFor(seed: string): { gradient: string; solid: string; initial: string } {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const hue = h % 360
  return {
    gradient: `linear-gradient(135deg, hsl(${hue} 62% 52%), hsl(${(hue + 48) % 360} 60% 42%))`,
    solid: `hsl(${hue} 55% 45%)`,
    initial: (seed.trim()[0] ?? '?').toUpperCase(),
  }
}

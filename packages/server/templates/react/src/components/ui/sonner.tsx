import { Toaster as Sonner, toast, type ToasterProps } from "sonner"

/**
 * Toast feedback. Mount <Toaster /> ONCE in App, then call toast() from anywhere:
 *   toast.success('Saved')  ·  toast.error('Could not save')  ·  toast('Added to cart')
 *
 * Themed from OUR tokens rather than next-themes (which the stock shadcn version pulls in): the app's
 * dark mode is the `dark` class on <html>, so the toast follows the same switch every other component
 * does, with no extra provider and no extra dependency.
 */
function Toaster({ ...props }: ToasterProps) {
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark")
  return (
    <Sonner
      theme={dark ? "dark" : "light"}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster, toast }

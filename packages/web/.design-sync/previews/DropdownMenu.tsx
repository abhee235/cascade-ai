import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuShortcut,
} from '@cascade/web'
import { Settings, Search, File } from 'lucide-react'

// NOTE: the trigger is styled inline (not `asChild` + <Button>) because this
// DS's Button is a plain function component without forwardRef, so a Radix
// `asChild` trigger can't anchor its popper under React 18.
export const Menu = () => (
  <DropdownMenu defaultOpen>
    <DropdownMenuTrigger className="inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium shadow-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
      Open menu
    </DropdownMenuTrigger>
    <DropdownMenuContent className="w-56">
      <DropdownMenuLabel>My account</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem><File /> New file <DropdownMenuShortcut>⌘N</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem><Search /> Search <DropdownMenuShortcut>⌘K</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuItem><Settings /> Settings <DropdownMenuShortcut>⌘,</DropdownMenuShortcut></DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem checked>Show sidebar</DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive">Delete project</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
)

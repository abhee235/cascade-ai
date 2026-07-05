import {
  Command, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem, CommandShortcut,
} from '@cascade/web'
import { File, Folder, Search, Settings, Play } from 'lucide-react'

export const Palette = () => (
  <Command className="max-w-md rounded-lg border shadow-md">
    <CommandInput placeholder="Search commands…" />
    <CommandList>
      <CommandEmpty>No results found.</CommandEmpty>
      <CommandGroup heading="Suggestions">
        <CommandItem><File /> New file <CommandShortcut>⌘N</CommandShortcut></CommandItem>
        <CommandItem><Folder /> New folder</CommandItem>
        <CommandItem><Search /> Search project <CommandShortcut>⌘K</CommandShortcut></CommandItem>
        <CommandItem><Play /> Run dev server <CommandShortcut>⌘⏎</CommandShortcut></CommandItem>
      </CommandGroup>
      <CommandGroup heading="Settings">
        <CommandItem><Settings /> Preferences <CommandShortcut>⌘,</CommandShortcut></CommandItem>
      </CommandGroup>
    </CommandList>
  </Command>
)

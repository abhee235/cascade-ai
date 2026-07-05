import { Tooltip, TooltipTrigger, TooltipContent } from '@cascade/web'
import { Settings } from 'lucide-react'

// NOTE: the trigger is styled inline (not `asChild` + <Button>) because this
// DS's Button is a plain function component without forwardRef, so a Radix
// `asChild` trigger can't anchor its popper under React 18.
export const OnButton = () => (
  <div className="flex items-center justify-center p-12">
    <Tooltip defaultOpen>
      <TooltipTrigger
        aria-label="Settings"
        className="inline-flex size-9 items-center justify-center rounded-md border bg-background shadow-xs outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 [&_svg]:size-4 [&_svg]:shrink-0"
      >
        <Settings />
      </TooltipTrigger>
      <TooltipContent>Open settings</TooltipContent>
    </Tooltip>
  </div>
)

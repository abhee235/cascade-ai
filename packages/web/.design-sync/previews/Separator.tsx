import { Separator } from '@cascade/web'

export const Horizontal = () => (
  <div className="max-w-sm">
    <div className="space-y-1">
      <h4 className="text-sm font-medium leading-none">Cascade Web</h4>
      <p className="text-sm text-muted-foreground">A browser frontend for the engine.</p>
    </div>
    <Separator className="my-4" />
    <div className="flex h-5 items-center gap-4 text-sm">
      <span>Docs</span>
      <Separator orientation="vertical" />
      <span>Guides</span>
      <Separator orientation="vertical" />
      <span>API</span>
    </div>
  </div>
)

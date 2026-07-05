import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
  SheetFooter, SheetClose, Button, Input,
} from '@cascade/web'

export const RightDrawer = () => (
  <Sheet defaultOpen>
    <SheetContent>
      <SheetHeader>
        <SheetTitle>Project settings</SheetTitle>
        <SheetDescription>Manage configuration for this project.</SheetDescription>
      </SheetHeader>
      <div className="grid gap-4 px-4">
        <div className="grid gap-2">
          <label htmlFor="sheet-name" className="text-sm font-medium">Name</label>
          <Input id="sheet-name" defaultValue="cascade-web" />
        </div>
        <div className="grid gap-2">
          <label htmlFor="sheet-domain" className="text-sm font-medium">Domain</label>
          <Input id="sheet-domain" defaultValue="cascade.app" />
        </div>
      </div>
      <SheetFooter>
        <Button>Save changes</Button>
        <SheetClose asChild><Button variant="outline">Cancel</Button></SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
)

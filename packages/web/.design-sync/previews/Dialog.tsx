import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogClose, Button, Input,
} from '@cascade/web'

export const RenameProject = () => (
  <Dialog defaultOpen>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>
          Give your project a new name. This also updates its URL slug.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 py-2">
        <label htmlFor="project-name" className="text-sm font-medium">Project name</label>
        <Input id="project-name" defaultValue="cascade-web" />
      </div>
      <DialogFooter>
        <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
        <Button>Save changes</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)

export const DeleteConfirmation = () => (
  <Dialog defaultOpen>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Delete “cascade-web”?</DialogTitle>
        <DialogDescription>
          This permanently removes the project and all of its deployments. This action cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
        <Button variant="destructive">Delete project</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)

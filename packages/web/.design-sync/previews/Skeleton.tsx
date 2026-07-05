import { Skeleton } from '@cascade/web'

export const Card = () => (
  <div className="flex max-w-sm flex-col gap-3 rounded-lg border p-4">
    <Skeleton className="h-32 w-full rounded-md" />
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-1/2" />
  </div>
)

export const ListItem = () => (
  <div className="flex max-w-sm items-center gap-3">
    <Skeleton className="size-10 rounded-full" />
    <div className="grid flex-1 gap-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  </div>
)

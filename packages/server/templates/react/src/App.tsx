import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export default function App() {
  const [count, setCount] = useState(0)
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
      <Card className="w-80">
        <CardHeader>
          <CardTitle>Your app starts here</CardTitle>
          <CardDescription>
            Edit <code className="rounded bg-muted px-1.5 py-0.5">src/App.tsx</code> and ask Cascade to build something.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Button onClick={() => setCount((c) => c + 1)}>count is {count}</Button>
          <Badge variant="secondary">shadcn/ui ready</Badge>
        </CardContent>
      </Card>
    </main>
  )
}

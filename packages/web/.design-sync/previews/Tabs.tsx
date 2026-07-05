import { Tabs, TabsList, TabsTrigger, TabsContent } from '@cascade/web'

export const Default = () => (
  <Tabs defaultValue="preview" className="w-96">
    <TabsList>
      <TabsTrigger value="preview">Preview</TabsTrigger>
      <TabsTrigger value="code">Code</TabsTrigger>
      <TabsTrigger value="console">Console</TabsTrigger>
    </TabsList>
    <TabsContent value="preview" className="rounded-md border p-4 text-sm text-muted-foreground">
      The live preview of your app renders here.
    </TabsContent>
    <TabsContent value="code" className="rounded-md border p-4">
      <pre className="font-mono text-sm">{`export default function App() {\n  return <Hello />\n}`}</pre>
    </TabsContent>
  </Tabs>
)

export const LineVariant = () => (
  <Tabs defaultValue="all" className="w-96">
    <TabsList variant="line">
      <TabsTrigger value="all">All</TabsTrigger>
      <TabsTrigger value="errors">Errors</TabsTrigger>
      <TabsTrigger value="warnings">Warnings</TabsTrigger>
    </TabsList>
    <TabsContent value="all" className="p-4 text-sm text-muted-foreground">
      No problems detected in the workspace.
    </TabsContent>
  </Tabs>
)
